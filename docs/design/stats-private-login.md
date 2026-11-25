# /stats: own sign-in and Worker-bound metrics

## Originating requirement

The operator, 2026-11-25, answering the decision form about the /stats analytics token
(paraphrased from Russian; source: the decision recorded on this lane's task): rework the
private /stats page with a different login and take Cloudflare out of it, because its
analytics token keeps needing replacement and signing in to Cloudflare every time is very
inconvenient.

The pinned specification makes this two outcomes. (1) Sign-in without Cloudflare Access: once
per device, with no vendor console and no secret the operator rotates, then weeks without
signing in again, through a long-lived, HttpOnly, Secure, SameSite=Strict, revocable session.
(2) Metrics read through a Worker binding, so no Cloudflare API token is used at read time,
with history carried over and any loss stated. Acceptance: anonymous /stats gets the sign-in
page or 401/403 and no metrics; after sign-in every section renders real data; the session
survives a browser restart for at least 30 days and can be revoked; no Access application
and no STATS_AE_TOKEN is needed; nothing secret is logged; Worker tests cover missing,
forged, expired and revoked sessions and a replayed enrollment link. Out of scope: moving the
landing, public pages, new metrics.

## What exists (read 2026-11-25, main `32f1df64`)

- `landing/worker.ts:83` sends /stats and /stats/ to `statsResponse`, which refuses unless
  `validAccess` (`:141-166`) verifies the Access JWT, then runs eleven Analytics Engine (AE)
  queries (`:222-232`) through `statsQuery` (`:170-186`) with the STATS_AE_TOKEN secret. Its
  CSP (`:208`) allows no script and no form. `landing/wrangler.jsonc` holds the Access vars,
  three AE datasets and `run_worker_first` for `/api/*`, `/stats` and `/stats/`.
- `/api/ping` (`:100`) and `/api/event` (`:104-108`) each write one AE point. The producers
  are the Viewer's daily sender (`src/lib/telemetry/sender.ts:32`) and the landing's beacons
  (`landing/site/main.js:20`); `swarm_usage` has none
  (`docs/verification/swarm-usage-stats.md:50-54`).
- Production, read-only API calls with the deploy token, no values printed: the Worker binds
  ASSETS, the installs and site_events datasets, the two Access vars and the secrets
  STATS_ACCOUNT_ID and STATS_AE_TOKEN; no swarm binding (it predates #3288), no cron, no
  Durable Object namespace. Anonymous `GET /stats` answers 302 to the Access login. The deploy
  token reads Worker settings and Durable Object namespaces (200) and gets 401 on D1, 403 on
  zone Access applications and 403 on account API tokens.
- AE history, one read with the analytics read token, counts only: installs from 2026-10-01
  (56 days), site_events from 2026-09-30, swarm_usage empty. AE keeps three months.
- Earlier answers: searches found the 2026-10-01 thread in which the read token was printed
  into a transcript and a rotation requested, and today's decision; no earlier sign-in design.

## 1. Sign-in: three options

| | A. Passkey after a one-time enrollment link | B. One-time secret link, then a long session | C. Password form, then a long session |
| --- | --- | --- | --- |
| Effort per visit | None while the session lives. One fingerprint, face or PIN prompt every 90 days, and on another browser that has the synced passkey. | None while the session lives. On expiry, cleared cookies or a new device the operator asks the seat for a new link and waits. | None while the session lives. Type or autofill the password on expiry. |
| Secrets to rotate | None. The private key stays in the authenticator; the link is single-use and expires in 24 hours. | None stored. Every renewal sends a fresh bearer link through a chat. | A password the operator keeps and replaces if it leaks. |
| Size in the Worker, no new dependency | About 450 lines: routes, WebAuthn checks with WebCrypto, store tables. | About 200 lines. | About 180 lines plus PBKDF2 hashing. |
| Attack surface | JSON, a fixed-offset authenticator record and a DER signature, parsed before or under signature verification. A stolen cookie reads until revoked or expired; a new session needs the device and its user verification. | The least code. Each renewal link is a full credential while it travels through a messenger and transcripts. | Online guessing that cannot be rate-limited (the Worker must not inspect IPs); phishable; reusable across sites. |

**Choice: A.** Renewal is self-service: with B every expiry, cleared cookie or new device
depends on the seat being up, while A needs only the operator's device, and a synced passkey
(iCloud Keychain, Google Password Manager) also signs in on their other devices in that
ecosystem with no new link. The only bearer credential that travels is the enrollment link,
once per device; B sends one per renewal and C keeps a reusable secret, which fails "no secret
they must rotate". A costs about 250 lines more than B and adds no dependency. Rejected before
the table: Telegram or GitHub login (a third-party account and console), mTLS client
certificates (configured in the Cloudflare dashboard), HTTP Basic (a password, held only until
the browser closes).

## 2. Data path: three options

| | D1 | SQLite-backed Durable Object | Keep AE writes |
| --- | --- | --- | --- |
| Read without a token | Yes, binding. | Yes, binding (RPC). | No: AE is read only through the SQL API with an account token. |
| Setup by hand | The deploy token gets 401 on D1, so the operator adds D1 edit to it or creates the database in the dashboard; `database_id` enters the config. | None: `wrangler deploy` creates the class through a migration under the deploy token's Workers permission. | None. |
| Single-use auth state | Batches. | One object; synchronous `transactionSync`. | Append-only; unusable. |
| Free-plan limits | 5 GB; 100,000 rows written and 5 million read a day; queries count toward the Worker's 50 subrequests, and the Worker gets 10 ms CPU. | SQLite backend only; 100,000 requests, 100,000 rows written and 5 million read a day; 5 GB; 30 s CPU per object request; alarms. | 100,000 points a day. |
| History import | In a 10 ms Worker request or a cron trigger. | In the object's alarm, with the token already bound. | — |
| Extras | Dashboard console; 30-day Time Travel. | 30-day point-in-time recovery; no row browser. | — |

**Choice: the SQLite-backed Durable Object** `StatsStore`, one object named `stats` with the
metric and auth tables. Of the two SQL stores it is the one the existing deploy token can
create, so it adds no console step, and its alarm carries the history over with the secret
already bound. AE writes stop in the same release: nothing reads AE after cutover, and
Cloudflare blocks rollbacks across a Durable Object class lifecycle change, so an AE copy buys
no rollback. The stores stay disjoint (AE holds only the previous version's writes, the object
only the new version's), so the import cannot count a point twice.

## 3. Design

### 3.1 Routes

The /stats routes answer on `STATS_ORIGIN` (`https://delegatus.org`); on `www` a GET answers
308 to the same path on the apex and other methods 403. Every answer carries
`Cache-Control: private, no-store`, `nosniff`, `Referrer-Policy: no-referrer` and
`frame-ancestors 'none'`. Every POST needs `Origin` equal to `STATS_ORIGIN` (else 403); other
methods get 405 with `Allow`; the existing `readBody` bounds every body; JSON routes answer 415
to another content type.

| Route | Requires | Request | Answer |
| --- | --- | --- | --- |
| `GET /stats`, `/stats/` | session | — | 200 stats page; otherwise 401 sign-in page, and no metric is read |
| `GET /stats/session` | cookie | — | 204 when the session is valid, else 401; empty body |
| `GET /stats/enroll` | — | — | 200 enrollment page; its script reads the token from the URL fragment |
| `POST /stats/enroll/options` | enrollment token | JSON `{token}`, ≤ 512 B | 200 creation options, or 403 |
| `POST /stats/enroll/finish` | enrollment token | JSON, ≤ 8 KiB | 204 and the session cookie, or 403 |
| `POST /stats/login/options` | — | empty | 200 request options; writes nothing |
| `POST /stats/login/finish` | assertion | JSON, ≤ 8 KiB | 204 and the session cookie, or 401 |
| `POST /stats/logout` | session | form | 303 to /stats; revokes this session; clears the cookie |
| `POST /stats/sessions/revoke` | session | form | 303; revokes every session |
| `POST /stats/passkeys/remove` | session | form field `id` | 303; revokes that passkey and its sessions |
| any other `/stats/*` | — | — | 404 |

The stats page CSP becomes `default-src 'none'; style-src 'unsafe-inline'; form-action
'self'; frame-ancestors 'none'; base-uri 'none'`; the sign-in and enrollment pages add
`script-src 'nonce-<16 random bytes>'; connect-src 'self'`. The sign-in page first calls
`GET /stats/session`: a same-origin fetch carries the SameSite=Strict cookie, which a
navigation from a messenger link omits, so on 204 the page replaces itself with /stats and the
operator sees the stats with no prompt. Otherwise it shows one "Sign in with passkey" button,
or says the browser cannot use passkeys when `PublicKeyCredential` is missing. The stats page
gains an "Access" section at its end: Sign out, Sign out on all devices, each passkey's
creation and last-use dates with Remove, and the history import status (§3.9).

### 3.2 Session cookie

`__Host-dlg_stats=<43 base64url characters>; Path=/; Max-Age=7776000; Secure; HttpOnly; SameSite=Strict`

The value is 32 random bytes; the store keeps only its SHA-256. A session is valid while its
row exists, `revoked_at` is null, `expires_at` (creation plus 90 days, absolute) lies ahead and
its passkey is not revoked. `Max-Age` makes the cookie survive a browser restart; 90 days
covers the required 30 at one prompt a quarter. The specification says "signed": a random
token checked against the store is equally unforgeable (2^256 guesses), revocation is a row
update, and no signing key exists to rotate. `__Host-` forbids a Domain attribute, so no other
subdomain can plant the cookie; with `Path=/` it also reaches `/api/*`, whose handlers keep
ignoring cookies. A malformed value or two cookies of that name are refused before the store
is asked.

### 3.3 WebAuthn checks

RP ID `STATS_RP_ID` (`delegatus.org`), origin `STATS_ORIGIN`, user verification required,
attestation `none`, discoverable credentials, ES256 (-7) and RS256 (-257, at least 2048 bits).
Checks and state changes run in the store; each state change is one `transactionSync` after
the last `await`, so concurrent replays meet a primary key and only one succeeds.

Challenges are stateless: purpose (enroll or login), expiry (5 minutes to enroll, 2 to sign
in), 16 random bytes, and an HMAC-SHA-256 over these plus, for enrollment, the enrollment
hash. The key is 32 random bytes the store creates on first start and never returns; nobody
configures or rotates it. Options routes therefore write nothing. A finish records the nonce
in `used_challenges`, so an assertion counts at most once.

Enrollment finish receives the credential id, `clientDataJSON`, `authenticatorData`, and the
SPKI and algorithm from `getPublicKey()` and `getPublicKeyAlgorithm()` (available across
browsers since October 2023, per MDN). Checks, in order: (1) the token's SHA-256 equals the
hash in STATS_ENROLLMENT (`timingSafeEqual`), the secret is unexpired, and the hash is absent
from `used_enrollments`; (2) `clientDataJSON` has type `webauthn.create`, a challenge whose
HMAC is valid for this enrollment and unexpired, the exact origin, and `crossOrigin` absent or
false; (3) `authenticatorData` has at least 37 bytes, the RP ID hash, and UP and UV set;
(4) the algorithm is allowed, WebCrypto imports the SPKI (at most 600 bytes), and the
credential id has 16 to 1023 bytes and is new; (5) one transaction inserts the used hash, the
credential and a session.

No CBOR is parsed: with attestation `none` nothing signs the registration, so trust in the key
comes only from the single-use link, whose holder could register any key anyway. A key that
differs from the one inside `authenticatorData` only fails its own sign-ins.

Login finish receives the credential id, `clientDataJSON`, `authenticatorData`, signature and
user handle. Checks: the credential exists and is not revoked (an unknown id gets 401 before
any crypto); type `webauthn.get`; the challenge's HMAC, purpose and expiry; origin; RP ID
hash; UP and UV; the signature over `authenticatorData` followed by the SHA-256 of
`clientDataJSON`, ES256 converted from strict DER to raw r and s; a sign count that grows when
stored and received counts are both non-zero (synced passkeys report 0). One transaction then
inserts the nonce, updates the count and last use, and inserts the session.

### 3.4 Enrollment link

A new seat script, `bun landing/scripts/stats-enrollment.ts`, draws 32 random bytes, pipes
`v1.<expiry in Unix seconds>.<hex SHA-256>` (24 hours) into `wrangler secret put
STATS_ENROLLMENT --config landing/wrangler.jsonc` through stdin, and prints the link
`https://delegatus.org/stats/enroll#<token>` once. Browsers never send the fragment, so
link-preview fetchers and request logs never see the token and a GET consumes nothing; the
page then drops it with `history.replaceState`. One run per device. A used hash stays refused,
a transcript copy is inert once used or expired, and an unexpected passkey shows in Access.

### 3.5 Storage schema

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- schema_version, challenge_key, user_handle, live_since, import_done, import_error, import_attempts
CREATE TABLE install_days (day TEXT NOT NULL, id TEXT NOT NULL, v TEXT NOT NULL,
  os TEXT NOT NULL, arch TEXT NOT NULL, kind TEXT NOT NULL, country TEXT NOT NULL,
  last_at INTEGER NOT NULL, PRIMARY KEY (day, id)) WITHOUT ROWID;
CREATE INDEX install_days_id ON install_days (id, day);
CREATE TABLE site_event_days (day TEXT NOT NULL, event TEXT NOT NULL, agent TEXT NOT NULL,
  lang TEXT NOT NULL, country TEXT NOT NULL, total REAL NOT NULL,
  PRIMARY KEY (day, event, agent, lang, country)) WITHOUT ROWID;
CREATE TABLE swarm_usage_days (day TEXT NOT NULL, rule TEXT NOT NULL,
  reports INTEGER NOT NULL, delivered INTEGER NOT NULL, applied INTEGER NOT NULL,
  misled INTEGER NOT NULL, misled_reports INTEGER NOT NULL, PRIMARY KEY (day, rule)) WITHOUT ROWID;
CREATE TABLE credentials (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE used_enrollments (hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
CREATE TABLE used_challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE imported_days (day TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);
```

Days are UTC `YYYY-MM-DD`, times Unix milliseconds. The constructor creates the schema under
`blockConcurrencyWhile`, sets `live_since` and the challenge key once and arms the alarm. The
SQL stays within SQLite 3.39: Bun tests run it on `bun:sqlite`, the system SQLite on macOS.

### 3.6 Page sections from the store

One `snapshot(now)` call returns every section with its own `failed` flag, so the renderer and
its inline "Data unavailable" stay. D0 is the first of the 30 UTC days and T is today.

| Section | Query |
| --- | --- |
| Today, 7 and 30 days | `count(DISTINCT id)` from `install_days` with `day BETWEEN ? AND T` |
| Daily active installs | `day, count(*)` grouped by day, `day >= D0` |
| New installs per day | each id's first day over the table (92 days kept), counted where it is `>= D0` |
| Version, OS / architecture, install kind | `count(DISTINCT id)` grouped, `day >= D0`, top 100 |
| Landing actions per day | `day, event, sum(total)` grouped, `day >= D0`, limit 120 |
| Newest ping | `max(last_at)`, formatted `YYYY-MM-DD HH:MM:SS` |
| Swarm rule usage | per-rule sums, `day >= D0`, limit 1000 |

These match today's AE semantics at day granularity; the sender pings once a UTC day. A page
view makes about seven passes over 30 days of install rows, far inside 5 million rows a day.

### 3.7 Write path

Validation, status codes, body limits and the country rule stay, so every released Viewer and
the landing script work unchanged. `/api/ping` calls `recordPing` (insert, or update on
`(day, id)` with the newest fields); `/api/event` calls `recordEvent` (insert, or `total + 1`).
A store failure rejects, so no 204 is sent, as with a failed AE write today. `writeDataPoint`
and the AE bindings go; the future `/api/swarm/usage` (`swarm-role-memory.md` §3.2) writes
`swarm_usage_days`. A ping costs one object request and about two rows, an event one and one.
A flood of `/api/event` can exhaust the free 100,000 requests a day, as with AE today.

### 3.8 Alarm and retention

While the import is pending the alarm runs an import step and re-arms in 1 s (60 s after a
failure). Otherwise it deletes metric rows older than 92 days (AE's three months), expired or
revoked sessions, expired nonces and passkeys revoked over 92 days ago; then 03:00 UTC again.

### 3.9 History import

The import runs while STATS_AE_TOKEN and STATS_ACCOUNT_ID are bound and `import_done` is
unset. Days run oldest first, from `live_since` minus 92 days to the day of `live_since`; the
last day waits until 10 minutes after `live_since`, when no instance of the previous version
still writes AE. Each step sends two queries through the existing `statsQuery` (POST, secret
kept server-side, 10-second timeout, `redirect: "manual"`, shape checks):

```sql
SELECT blob1 AS id, blob2 AS v, blob3 AS os, blob4 AS arch, blob5 AS kind, blob6 AS country,
  formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') AS at
FROM installs WHERE <the day's window> ORDER BY at LIMIT 10000
SELECT blob1 AS event, blob2 AS agent, blob3 AS lang, blob4 AS country,
  sum(_sample_interval * double1) AS total
FROM site_events WHERE <the day's window> GROUP BY event, agent, lang, country LIMIT 1000
```

Rows pass the validators that live writes use; invalid rows are skipped and counted. A result
that reaches its limit stops the import with an error, so no day is truncated. One transaction
then inserts the `imported_days` row (an existing row makes the step a no-op), merges install
rows with the newest winning, and adds event totals to any live rows of that day. Three failed
attempts on one day stop the import with `import_error` set to a fixed class (`http`,
`network`, `shape`, `limit`), shown in the Access section. A new deployment, including a
`wrangler secret put`, restarts the object, and its constructor resumes a stopped import once.
Logging: the auth and store paths log only `stats-import day=<day> ok`, `… stopped <class>`
and `… complete days=<n>`. No token, cookie, assertion, key, challenge, credential id or
metric value reaches a log, an error or any page except the signed-in stats page.

Budget: a bucketed read on 2026-11-25 (counts kept private) found the history unsampled and
far below the per-day limits; the import, at most 558 AE queries with every retry, stays
inside the free 10,000 AE queries and 100,000 written rows a day with a wide margin.

**Carried over:** every retained AE point, today all history since 2026-10-01 (installs) and
2026-09-30 (events), if the import finishes before about 2027-01-01. **Lost:** ping times other
than each install's latest of the day, which the page never showed; swarm data is empty. If the
bound token cannot read AE, the seat puts the same token again through stdin; if that fails,
the seat accepts the loss, since a new token would bring back the console step the operator
asked to remove: the 30-day sections fill 30 days after cutover, and a returning install can
count as new until the store holds 92 days.

### 3.10 Configuration and files

```jsonc
"main": "entry.ts",
"assets": { /* unchanged, plus */ "run_worker_first": ["/api/*", "/stats", "/stats/", "/stats/*"] },
"vars": { "STATS_ORIGIN": "https://delegatus.org", "STATS_RP_ID": "delegatus.org" },
"durable_objects": { "bindings": [{ "name": "STATS", "class_name": "StatsStore" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["StatsStore"] }]
```

The Access vars and `analytics_engine_datasets` go. Secrets: the new STATS_ENROLLMENT, plus
STATS_AE_TOKEN and STATS_ACCOUNT_ID until the import completes. The config uses `migrations`
only; a Worker once deployed with the newer `exports` field cannot go back.

Files: `landing/entry.ts` is the Wrangler entry; it re-exports the fetch handler and a
15-line shell, `StatsStore extends DurableObject`, that forwards its RPC methods and `alarm()`
to `StatsCore`. `landing/worker.ts` keeps routes, cookies and pages and loses `validAccess`
and the JWKS cache. `landing/stats/store.ts` holds `StatsCore` over a small storage interface;
`landing/stats/webauthn.ts` the base64url, DER and WebAuthn record checks;
`landing/cloudflare-workers.d.ts` the declarations the repository typecheck needs. Bun tests
import `worker.ts` and `StatsCore` with a storage adapter over `bun:sqlite`, so no Cloudflare
module is mocked; the workerd harness bundles `entry.ts` with esbuild (`cloudflare:*`
external) and runs the real object with SQLite storage in Miniflare.

Docs the builder updates: `docs/design/usage-metrics.md` §3, `docs/guide/security-and-privacy.md:29-30`
(where ping values are stored), `landing/site/README.md` (bindings, AE permissions, event
reader note), `landing/runtime-tests/README.md`, `docs/design/swarm-role-memory.md` §3.2.

## 4. Tests

`landing/worker.test.ts` (Bun) uses a virtual authenticator, a generated P-256 key that builds
`clientDataJSON`, `authenticatorData` and a DER signature as browsers do. Every refusal asserts
its status, no `Set-Cookie`, no metric text, unchanged row counts and no console output. Run it
on the head and on main's `landing/worker.ts` in a scratch export to record red on main.

| # | Case | Expected |
| --- | --- | --- |
| 1 | `GET /stats` and `/stats/` with no cookie | 401 sign-in page; `snapshot` never called |
| 2 | malformed value, duplicated cookie, the value under another name | 401; no store call |
| 3 | forged: a well-formed random token absent from the store | 401 |
| 4 | expired: the same cookie at 30 and 89 days after sign-in (clock moved), then at 90 | 200, 200, then 401 |
| 5 | revoked: after logout, after "all devices", after removing its passkey | 401 each |
| 6 | the issued cookie | exactly the attributes of §3.2 |
| 7 | enrollment with no token, a wrong token, an expired secret, an unset or malformed STATS_ENROLLMENT | 403 |
| 8 | replayed link: second options call and second finish after success; two concurrent finishes | 403 and one passkey; one 204 and one 403 |
| 9 | enrollment finish with wrong type, foreign origin, `crossOrigin: true`, a challenge with a bad HMAC, expired, for another enrollment or for login, wrong RP ID hash, UP or UV missing, algorithm -8, an unparsable or short RSA key, a registered id, a body over 8 KiB | 403; nothing stored |
| 10 | sign-in with an unknown or revoked credential, another key's signature, tampered `clientDataJSON` or `authenticatorData`, type `webauthn.create`, foreign origin, expired or forged challenge, UV missing, a non-zero sign count that does not grow | 401 |
| 11 | replay of a successful assertion; two concurrent finishes with one assertion | 401; one session |
| 12 | both options routes | no row changes |
| 13 | POST without `Origin` or with a foreign one; wrong method; other content type on JSON routes; GET and POST on `www`; unknown `/stats/*` | 403 and no change; 405 with `Allow`; 415; 308 to apex and 403; 404 |
| 14 | ping and event, a second ping that day, the existing invalid bodies, a store failure, cookies and IP headers | expected rows; row updated; nothing written; rejects; ignored |
| 15 | `snapshot` over fixture rows: first-seen over 92 days, an install that updated, empty and failed sections, escaping | every section of the existing list and render exports |
| 16 | alarm retention | rows older than 92 days, expired sessions and nonces deleted |
| 17 | import against stubbed AE: repeated step, live rows of the same day, reached limit, HTTP error, redirect, bad JSON, no token | each day once; no-op; events added and newest install row kept; stop with the class after three attempts and no upstream text; no outbound call; token in no page or log |
| 18 | `landing/wrangler.jsonc` | the keys of §3.10; no Access vars, AE datasets or secrets in vars |

`landing/runtime-tests/access.workerd.mjs`, renamed `stats.workerd.mjs`, enrolls and signs in
with the virtual authenticator in workerd on Miniflare's SQLite object, reads every section,
and runs cases 1, 3, 4, 5, 8, 11 and the import redirect. Rendered evidence, fictional data,
through the existing `STATS_RENDER_DIR` export and the capture of
`docs/verification/swarm-usage-stats.md`: sign-in (ready, no passkey support), enrollment
(ready, used link), the stats page with each import state, at 1280, 800 and 390 px.

## 5. Rollout

1. Merge after the required checks (privacy-publication, privacy-tracker-audit, runtime-gate,
   typecheck) and three review rounds.
2. Deploy. Seat: bounded `wrangler tail`, then `bunx wrangler deploy --config
   landing/wrangler.jsonc`; the migration creates the object. Access still covers /stats, so a
   defective release exposes nothing; rollback across the class creation is blocked.
3. Import. Seat: wait for `stats-import complete` (about 12 minutes: 93 steps and the 10-minute
   wait). On `stopped`, put STATS_AE_TOKEN again through stdin once and wait again. Then
   `wrangler secret delete` STATS_AE_TOKEN and STATS_ACCOUNT_ID: no API token reads metrics.
4. Enroll, cut over, revoke. Seat: run the enrollment script and send the link in one private
   message with §6. Operator: §6, one visit that deletes the Access application and revokes
   the token (step 3 already finished with it), then the passkey.
5. Verify. Seat, on production: anonymous `GET /stats` gets the 401 sign-in page with no metric
   text; `POST /stats/enroll/options` with the used token gets 403; a second link enrolls a
   DevTools virtual authenticator in headless Chrome, every section must render real data
   (frames stay private in the evidence directory), then the seat removes that passkey,
   confirms its cookie gets 401, and deletes STATS_ENROLLMENT.
6. Seat: confirm Cloudflare's token verification refuses the old token, loaded privately from
   its protected source. A follow-up pull request removes the import code and `statsQuery`,
   inert without the secrets until then.

## 6. What the operator does by hand

One Cloudflare dashboard visit (the deploy token gets 403 on Access applications and on API
tokens): (1) Zero Trust → Access → Applications: delete the application protecting /stats on
delegatus.org and www; (2) API Tokens: revoke the analytics read token /stats used. Then open
the link on each device where they read the stats and confirm the passkey prompt (fingerprint,
face or PIN); if Access is still in place it asks for its login once more first. Where a
browser cannot hold a passkey, the phone or a security key works; one link per device.

## 7. Risks

- Passkeys on the desktop browser: recent Chrome on Linux saves them in Google Password
  Manager and otherwise offers the phone over Bluetooth; neither is verified on the operator's
  machine. Per-device links and the phone cover it.
- After step 2 fixes go forward only. Free daily quotas are shared with flood traffic, as with
  AE today. A distant ping adds one round trip to the object, inside the sender's 5 s timeout.
- The import's AE SQL, like today's page queries, has never run through the Worker. The read
  token answered these datasets from this machine on 2026-11-25, and step 3 watches the
  outcome before any token is removed.

## Deferred — not currently justified

An add-device link minted from the signed-in page (the seat's script covers the rare case);
sliding sessions and last-seen writes; rate limiting `/api/*` (the Worker must not inspect IP
addresses); aggregates kept beyond 92 days; attestation verification and CBOR parsing; a
Ukrainian sign-in page (the stats page is English only); D1 and its dashboard console.

## Checked against the requirement

- Different login: a passkey; no Cloudflare login per visit after §6. Token: none read after
  step 3, the exposed one revoked in §6 and checked in step 6, nothing left to rotate.
- Anonymous /stats: 401 without metrics (tests 1–3, step 5). Signed in: every section renders
  real data (test 15, workerd, step 5). Restart-proof for 90 days and revocable (§3.2, tests
  4–6, step 5). No Access application or STATS_AE_TOKEN (§3.10, steps 3 and 4). Nothing
  secret logged (§3.9, every test). History carried over, loss stated (§3.9).
- Scope: hosting unchanged, no public page, no new metric (the Access section is controls).
