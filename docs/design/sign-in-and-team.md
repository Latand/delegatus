# Sign-in and team: members, message authorship, who did what

Status: design. Written 2026-09-26 against `main` at `0f5dae610`. Product
source is untouched; this document is the lane's only output. The build lane
that follows implements it in the slices of §13.

## 0. Originating requirement

The pinned specification of this pipeline task, 2026-09-26. The record is the
orchestrator's English paraphrase of the operator; it is quoted here as it was
pinned, unedited. It carries no credentials and no personal data.

> The operator wants Delegatus to become a tool for team development and a
> team dashboard. The first and most important step is a beautiful,
> well-thought-out sign-in module. You are trusted to make the key decisions
> yourself; the operator will correct later if needed. Use your judgment rather
> than waiting for permission, and record each decision with its reasoning.
>
> What the operator asked for (paraphrased):
> - Each person signs in as themselves. Linking the account to Telegram is
>   attractive if it makes sense.
> - Delegatus tracks who does what: who sent which request, who started which
>   agent, who changed which task.
> - The chat shows the sender's name on human messages.
> - Today the shared stage server (the stage host, its name redacted here; one Delegatus install used by
>   the operator and a teammate) has only a primitive access scheme with a few
>   accounts; sign-in should work there as well as on the operator's own
>   machine.
> - Open question the operator raised: should team features live in a closed
>   edition (a fork kept in sync with the open-source core) while the
>   open-source Delegatus stays single-user, as a business model? Decide and
>   explain. Whatever you decide, build the module now in this repository
>   behind a clean boundary (its own directory / module seam) so it can move to
>   a closed edition later without a rewrite, and say what that move would
>   take.
> - The operator asked about Telegram: the Telegram Login Widget (bot-based)
>   gives a signed identity only, while an MTProto app (api_id/api_hash
>   registered by the operator as "Delegatus", possibly shipped hard-coded so
>   everyone uses the same app, with QR login like the Telegram connector
>   already does) acts as the user's whole account. Verify the real
>   capabilities and terms from primary sources, then choose what sign-in
>   should use and why. Do not ship anything that grants Delegatus a member's
>   full Telegram account just to identify them.
>
> Deliver, in this lane: (1) docs/design/sign-in-and-team.md with the
> decisions, the member/session/authorship model, the sign-in methods, the
> first-run flow for the owner and for inviting a teammate, how existing token
> access keeps working, the audit trail of who did what, and the open-core
> recommendation; (2) a working sign-in module: sign-in page and flows,
> members and sessions (revocable), authorship stamped on human-originated
> actions (messages, spawns, task changes) and the sender's name shown in
> chat, and a simple view of who did what. It must look good and feel
> considered (design skills, anti-slop, real references), in en and uk,
> desktop and phone. Keep single-user local use frictionless.

The same ask was first recorded on 2026-09-03 in issue #1497, in the
operator's own words (in Russian, quoted there). In English: people sign in to
the Viewer itself; whoever is signed in is the one whose message is sent; every
message carries a visible signature of who sent it, readable by everyone else.
That issue's acceptance list (two people on two devices, a third person sees
distinct authors; a session survives reload and a new tab; a solo operator
sees no new step; authorship is in the durable record and readable over MCP;
revoking access stops new messages and keeps old attribution) is adopted here
unchanged and validated in §15.

**Should this be built?** Yes. The requirement names the capability, and
nothing in Delegatus can do it: `src/lib/agent/operatorAuthority.ts` answers
exactly one question, "operator or agent", and by design never asks which
human. On the shared stage box every teammate is therefore one principal, and
their messages carry no author. Everything past what the quote asks for is
under §14, Deferred.

## Decisions in one page

| # | Decision | Why (short) |
|---|---|---|
| D1 | **Two layers, kept apart: the perimeter and the identity.** The perimeter (`LLV_TOKEN`, `?k=`, the tailnet, Caddy on the stage box) stays exactly as it is and keeps deciding who may reach the Viewer at all. Identity is a new, additive layer that says which **member** a browser is. | The perimeter is enforced in `src/proxy.ts` and fed by the runtime host's entries (#1549), which are byte-identical across releases and must stay stable. Replacing it with cookies would touch the host; adding a layer beside it touches nothing there. |
| D2 | **Two modes, decided by data: `solo` and `team`.** No members store → `solo`: every same-origin human request is the unnamed operator, exactly today. One owner in the store → `team`: every human request needs a member session. | "Keep single-user local use frictionless" is met by construction: a solo install has no members file and never sees a sign-in page, a prompt or a name field. |
| D3 | **A member session is a cookie the browser keeps**, opaque, server-stored (hashed), revocable, 30 days idle / 180 days absolute. | #691 rounds 7–9 (`src/components/operatorCredential.ts`) were rejected because a fresh tab could not open the manager and a reload lost the credential. A cookie survives both and is pasted nowhere. |
| D4 | **Four ways in, one of them always available.** (a) an invite link from the owner; (b) approve a new device from a signed-in one, with a short code; (c) Telegram, through the bot Delegatus already runs, by deep link (`t.me/<bot>?start=<code>`); (d) a passkey, where the origin is HTTPS on a real host. Plus (e) a recovery link printed by the host CLI. | (a)+(b) need no third party and no HTTPS, so they work on a laptop, in a tailnet and on the stage box. (c) gives a verified Telegram identity with zero registration per install and opens the notification channel. (d) is the strong self-serve credential the #20 gate already specified. (e) is the root of recovery, as in #20 §4.6. |
| D5 | **Telegram: link and sign in through the bot's deep link; no MTProto app; OIDC "Telegram Login" deferred.** | Verified 2026-09-26 (§2.1): QR/MTProto login yields a full user authorization, which the requirement forbids; Telegram's login is now an OpenID Connect flow needing pre-registered Allowed URLs and a client secret per bot, one registration per install origin; the bot deep link needs nothing beyond the bot token the install already holds. |
| D6 | **Passkeys through `@simplewebauthn/server` 14.0.3 + `@simplewebauthn/browser` 14.0.0** (MIT, pure JS). RP ID = the request's own host; a credential is offered only on the host it was made for. | Round-tripped under Bun 1.4.0 on this machine (§2.2). No RP-drift ceremony: a member simply has one passkey per origin they use. |
| D7 | **Identity is checked in `src/proxy.ts` (Node runtime) and re-checked at every stamp site.** The proxy redirects a browser without a session to `/sign-in` and answers `401 member_required` to API calls; the stamp sites refuse an anonymous human write in team mode. | Next 16's proxy runs on Node (§2.3), so one place sees every route including SSE and GET. The #20 plan's "call `requireSession` at the top of every handler" was never executed and is the kind of rule that gets missed. Belt and braces: the proxy is the UX and the coarse gate; the stamp site is the enforcement. |
| D8 | **Authorship is written into the records that already exist**, as a `TeamActor`: the structured-user metadata record and the Claude delivery ledger for messages, the registry conversation for spawns (`startedBy`), the task row for task edits (`createdBy`, `updatedBy`). Names are joined at read time from the members store. | Renames must not rewrite history; ids are stable, names are looked up. The transcript text an agent reads is unchanged. |
| D9 | **"Who did what" is one append-only collection, `team_events`, in `state.sqlite`**, written at the same chokepoints where `recordOperatorRequest` already runs. The activity dashboard's request ledger keeps its six-key privacy contract untouched. | One helper, one table, one page. The existing ledger deliberately stores no ids or titles; the audit needs both, so it is a sibling, never a widening. |
| D10 | **The chat shows the sender on every human message in team mode**, own messages included: a 16 px initials avatar in the member's colour and the name, above the bubble. Solo mode draws nothing new. | A shared screen reads the same for everyone; "You" would differ per viewer. Agent relays keep the internal card; Viewer-authored cards keep the emblem. |
| D11 | **One repository, MIT, team features included; no closed fork.** The module lives behind one seam (§11) so the option stays open. If a paid edition is ever wanted, the cheapest true move is a directory licence in the same repository (GitLab's `ee/` pattern) or a whole-repo source-available licence (FSL), never a synced fork. | A fork is a permanent merge tax with no customer today. The seam costs a day; the fork costs every week. |
| D12 | **Recovery root is the host.** `delegatus team recover` prints a one-time owner link; on Docker the same command runs in the release container. | Every other method can be lost with a phone; the machine cannot. Same principle as #20 §4.6. |

No ADR is filed: nothing here is hard to reverse. Members, sessions and events
are additive collections; the perimeter is untouched; the passkey and Telegram
methods are independent files behind one interface.

## 1. What exists today, verified in code

| Piece on main | What it does | What this design does with it |
|---|---|---|
| `src/proxy.ts` | The perimeter. With `LLV_TOKEN` set, every connection (loopback included, since #1503) presents the token: cookie `llv_auth`, `Authorization: Bearer`, or `?k=` which sets the cookie and redirects. The report frame path is exempt. | Untouched as the perimeter. Gains the identity gate after it (§4). |
| `src/lib/agent/operatorAuthority.ts` | `callerConversationId(req)` names an agent by its spawn capability header; `requireOperatorAuthority` refuses agents; `directOperatorActivityAuthority` also refuses the internal service tag (`monitor`, `mcp`, `orchestrator`). "The operator is the local browser." | Kept. The new `teamActor(req)` (§3.6) is built on top: an agent stays an agent, a service stays a service, and what used to be "the operator" becomes "member X" in team mode. |
| `src/lib/sameOrigin.ts` | CSRF gate: Host pinned to loopback + `LLV_TS_HOST`, Origin / Sec-Fetch-Site checked. | Kept on every mutation, including the new sign-in POSTs. |
| `src/runtime-host/deploymentProxy.ts` (#1549) | The stable port's entries: an authenticated remote entry and a trusted local entry that injects the release key as `Bearer` for loopback-addressed requests. | Untouched. Its injected bearer is a perimeter fact; identity does not read the `Authorization` header (§4.2). |
| `src/lib/access/phoneAccess.ts`, `bin/tailscale.mjs` `getToken` (#1876, #2024) | One-button phone access: publishes the Viewer in the tailnet and turns the key on; the QR carries `?k=`. | Kept. In team mode the QR carries a hand-off code too, so a scan signs the phone in as the same person (§5.2). |
| `src/lib/telegram/bot/*` (2026-09-24) | The Bot API poller (`getUpdates`, allowed updates include `message`), `TelegramBotStore` in `<state>/telegram/bot.sqlite`, the token fenced in one transport closure. | The Telegram sign-in rides this poller: a private-chat `/start <code>` message is consumed by the team module (§5.3). |
| `src/lib/telegram/connector.ts`, `adapter.ts` | The personal-account MTProto connector (QR login, read-only tool surface, operator root only). | Not used for identity. Its QR login is exactly the full-account authorization the requirement forbids (§2.1). |
| `src/lib/runtime/messageOrigin.ts`, `codexStructuredUserText.ts`, `src/lib/selection/structuredUserMetadata.ts`, `src/lib/runtime/claudeMessageProvenance.ts`, `src/app/api/log/provenance/route.ts` | Message authorship (#1117): `origin: operator \| agent(role)` stamped at admission, stored in the per-delivery metadata record (Codex) and the delivery ledger (Claude), joined for the feed by `/api/log/provenance`. | The records gain `member`; the provenance answer gains `sender` (§7.1). |
| `src/app/api/conversation-host/handlers.ts` | Operator sends: `directOperatorActivityAuthority` → WakaTime point → `recordOperatorRequest` → `enqueueStructuredMessage` with `origin`. | The stamp site for messages. |
| `src/lib/agent/spawnCommand.ts` (~L470) | Direct operator spawn: `recordOperatorActivity` and `recordOperatorRequest(kind: "spawn")`. | The stamp site for spawns. |
| `src/app/api/tasks/route.ts`, `[id]/route.ts` | Task create and patch: `recordOperatorRequest(kind: "task")`. | The stamp sites for task changes. |
| `src/app/api/answer/route.ts` | Answering an agent's question. | Event `question.answered`. |
| `src/lib/activity/requestLedger.ts` | Six-key privacy-bounded ledger for the activity dashboard. | Untouched. `team_events` is written beside it. |
| `src/lib/state/sqliteStateStore.ts` `SqliteStateCollection` | Revisioned, migrated collections in `state.sqlite`, opened lazily, writer authority via `hot-state-authority.json`. | All team stores are collections here (§3.5). |
| `src/lib/view/presenceStore.ts` | Who is looking, 25 s freshness, mirrored to a file. | `StoredViewSession` gains `memberId` from the session, one line, so the Members page can say "online · desktop". |
| `src/lib/operator/settings.ts` | One interface language per install, written from the toggle. | Unchanged in this slice; per-member locale is deferred (§14). |
| `src/components/feed/UserMessageRow.tsx`, `FeedItem.tsx` | The one shape of a human message; the internal card for agent relays; the emblem for Viewer-authored cards. | Gains the sender line (§6.7). |
| `src/components/ProjectRail.tsx` `RailHeaderMenu`, `src/components/onboarding/menuEntries.tsx` | The desktop ⋯ menu and the phone menu rows, incl. `/activity`. | Gain a "Team" row (§6.9). |
| `src/components/onboarding/*` (#1876, #2166) | The setup guide: engines, agents, phone, voice, tour, check; marker in `state/onboarding.json`. | Gains an optional "Team" step (§6.1). |
| `docs/design/viewer-design-system.md`, `delegatus-brand.md` | Tokens, two radii, four surfaces, the brand fill, the emblem files, contrast floor. | Every new surface uses these and nothing else (§10). |
| `src/lib/i18n/en.ts`, `uk.ts` (mirrored key sets, `i18n.test.ts`) | Hand-rolled dictionaries. | New keys under `team.*` (§10.3). |

**The stage box, read on 2026-09-26 over SSH (read-only):** one Viewer under a
systemd user unit with self-update releases, no Docker compose; `service.env`
holds one `LLV_TOKEN`; no `viewer-gateway.json`; Caddy on port 8443 terminates
TLS for a real DNS name and reverse-proxies to `127.0.0.1:8898` behind
`basic_auth` with a handful of per-person passwords. So today a teammate passes
Caddy as themselves and then becomes the one anonymous operator inside. The
stage box is the first customer of team mode and its cutover is in §8.3.

### 1.1 Prior work searched

`search_transcripts`, project-scoped then unscoped, for: "sign-in members
authorship viewer-native", "passkey WebAuthn password protected exposure",
"team workspace presence human chat #634", "Telegram login widget identity
open-core closed edition", "operatorCredential rejected fresh tab manager",
"stage teammate access password", the operator's 2026-09-03 Russian
phrasing, "open-core closed edition sign-in module business model", "api_id
api_hash … QR", and two Ukrainian/Russian phrasings of "team development,
sign-in, who did what".

Found and read: the 2026-09-03 orchestrator transcript holding the operator's
original words (the sentence #1497 quotes); the 2026-09-04 exposure-seam lane
(#1496/#1495 → PR #1503), whose reviewer brief explicitly fences "#1497's
identity work" out of that lane; and this lane's own prompt. Nothing earlier
designed members, sessions, Telegram sign-in or the open-core question in this
project. The three issues carry the prior thinking:

- **#20** (2026-07-10, the frozen "Fable gate"): a single-owner public-exposure
  auth with modes `local | tailnet | public`, a bootstrap CLI ceremony,
  scrypt password, passkeys via SimpleWebAuthn, hashed server sessions with a
  `__Host-` cookie, persistent throttle files, an audit ndjson, `?k=` disabled
  in public mode. Checked against current main: nothing of it was built; the
  proxy still knows one token. Its session and passkey specifics are sound and
  are taken here (§3.2, §5.4). Its modes, password path, persistent throttle
  store and public-mode fail-closed startup are heavier than this requirement,
  which asks for identity on installs that already have a perimeter; they are
  not built (§14).
- **#634** (the shared-workspace epic): `Member` with a stable id, sessions,
  owner plus additive capabilities, presence, chat lanes, handoff links. This
  document is its slice 0 in the narrow cut #1497 asked for. The capability
  matrix (`task:manage-others` etc.) is deferred; the model here leaves room
  for it (a member has `role` and an empty `grants` list).
- **#1497**: the first slice, its acceptance list adopted verbatim (§0). Its
  hard precondition #1496 is closed by #1503, so "identity in front of a
  bypass" no longer applies. Its warning about #691 rounds 7–9 is the reason
  for D3.

## 2. Verified external facts

Every claim below was read from the primary source on 2026-09-26, or observed
on this machine.

### 2.1 Telegram

**Telegram Login is now an OpenID Connect flow.** `core.telegram.org/widgets/login`
says: "This document describes the Telegram Login library and the new OpenID
Connect login flow. The legacy iframe-based JavaScript widget documentation is
archived". The flow: "Set up a bot to represent your application. Register your
Allowed URLs via @BotFather and obtain your Client ID and Secret." Endpoints
`https://oauth.telegram.org/auth`, `/token`, `/.well-known/jwks.json`;
authorization-code with PKCE; the token exchange "requires Basic Authorization
using your Client ID and Client Secret". "For security reasons, Telegram will
only process logins or redirect users using your pre-registered URLs." Scopes:
`openid` (required; `sub`, `iss`, `iat`, `exp`), `profile` (`id`, `name`,
`preferred_username`, `picture`), `phone`, `telegram:bot_access` ("Allows your
bot to send direct messages to the user after login"). The discovery document
at `https://oauth.telegram.org/.well-known/openid-configuration` answered live
with exactly those endpoints, `response_types_supported: ["code"]`,
`code_challenge_methods_supported: ["plain","S256"]`, and
`token_endpoint_auth_methods_supported: ["client_secret_basic","client_secret_post"]`.
The in-page JS library needs `Cross-Origin-Opener-Policy` to allow popups.

**The legacy widget** (`/widgets/login-legacy`) returns `id, first_name,
last_name, username, photo_url, auth_date, hash`, verified as "the HMAC-SHA-256
signature of the data-check-string with the SHA256 hash of the bot's token used
as a secret key", after linking the site's domain with `/setdomain`. It is
archived and is not what a new integration should target.

**What both give:** a signed statement that a Telegram user with a given id and
name approved this site. Neither reads the user's chats or acts as the user.

**Bot deep links** (`core.telegram.org/api/links`, `core.telegram.org/bots/features`):
`t.me/<bot_username>?start=<parameter>`, "up to 64 base64url characters";
"When someone opens a chat with your bot via this link, you will receive:
`/start airplane`". The message arrives as an ordinary `message` update whose
`from` is the user (id, first_name, username), which the existing poller
already receives in private chats ("Sees every message in this private chat",
`chatVisibility` in `src/lib/telegram/bot/service.ts`).

**MTProto QR login** (`core.telegram.org/api/qr-login`): the flow ends with
`auth.loginTokenSuccess`, "indicating successful login, essentially allowing
further authorized interaction with the API". That is a complete user session:
everything the account can do. The requirement forbids exactly this for
identification, and the personal connector's whole design on main is a
read-only fence around that same authority.

**The API terms** (`core.telegram.org/api/terms`): "You must obtain your own
api_id for your application." Shipping one Delegatus `api_id`/`api_hash` in a
public repository so that every install acts as one application is, at best,
the opposite of that sentence's intent, and it is unnecessary once the bot
answers the identity question.

**Decision (D5).** Identity comes from the bot: a deep link with a one-time
code, confirmed by the `/start <code>` message the poller receives. It needs no
domain registration, no client secret, no HTTPS, no telegram.org script on the
page, and no new process; it works on a phone (the Telegram app opens), in a
tailnet, and on the stage box, and it leaves the bot able to DM the member,
which is the notification channel #634 wants later. The OIDC flow is deferred
(§14): it is the right choice only for an install with a stable public origin
that wants the one-tap popup; it costs a BotFather registration per origin and
a client secret in state.

### 2.2 WebAuthn and the library

**RP ID rules** (W3C WebAuthn Level 3, editor's draft, `#rp-id`): "The RP ID
MUST be a valid domain string"; its value "either is identical to the caller's
origin's effective domain, or is a registrable domain suffix of the caller's
origin's effective domain"; "If the RP ID value is not provided, its value
will default to the caller origin's effective domain"; IP addresses are not
valid RP IDs. Consequences: passkeys work on the stage box's DNS name, on a
Tailscale MagicDNS name (`*.ts.net`, HTTPS via Tailscale certificates), and on
`localhost`; they do not work on `http://192.168.x.y` or on a bare tailnet IP.
The sign-in page offers the passkey button only where `PublicKeyCredential`
exists and the host is a domain (§5.4).

**Library.** `@simplewebauthn/server` latest 14.0.3 (published 2026-09-25),
MIT, `engines.node >= 20.0.0`, dependencies all pure JavaScript
(`@peculiar/asn1-*`, `@peculiar/x509`, `@hexagon/base64`,
`@levischuck/tiny-cbor`, `reflect-metadata`); its README names Node 22 LTS and
Deno 2.4 as supported runtimes and says nothing about Bun.
`@simplewebauthn/browser` 14.0.0, MIT, no dependencies.

**Observed under Bun 1.4.0 (the Dockerfile's pin) on this machine:** a scratch
project installed `@simplewebauthn/server@14.0.3` and ran a full round trip
with a WebCrypto P-256 key: `generateRegistrationOptions` →
`verifyRegistrationResponse` (fmt `none`, `verified: true`, counter 1) →
`generateAuthenticationOptions` → `verifyAuthenticationResponse`
(`verified: true`, newCounter 2); a signature with one flipped bit returned
`verified: false`. The library's crypto path runs on Bun's WebCrypto. The build
lane repeats this as a unit test (§13).

### 2.3 Next.js proxy runtime

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
(Next 16.3.3, the pinned version): "Proxy defaults to using the Node.js
runtime. The `runtime` config option is not available in Proxy files." So the
proxy may read the session collection. It must not resolve state at module
load (#1905): the gate is a function called per request, and its store opens
lazily on first team-mode request.

### 2.4 Licensing

- This repository: `LICENSE` is MIT, copyright the repository owner;
  `package.json` `license: "MIT"`. `CONTRIBUTING.md` accepts outside pull
  requests and has no CLA.
- MIT permits sublicensing and proprietary derivatives, which is what makes a
  closed edition legally trivial and what makes it commercially pointless as a
  moat: anyone may do the same with the core.
- GitLab's `LICENSE` (gitlab.com/gitlab-org/gitlab, master): "All content that
  resides under the "ee/" directory of this repository, if that directory
  exists, is licensed under the license defined in "ee/LICENSE"" and "Content
  outside of the above mentioned directories or restrictions above is
  available under the "MIT Expat" license." One repository, one build, a
  directory-scoped licence. This is the pattern §11 recommends if a paid
  edition is ever wanted.
- The Functional Source License, FSL-1.1-MIT (getsentry/fsl.software): "A
  Permitted Purpose is any purpose other than a Competing Use. A Competing Use
  means making the Software available to others in a commercial product or
  service that: (1) substitutes for the Software; (2) substitutes for any
  other product or service we offer using the Software …; or (3) offers the
  same or substantially similar functionality as the Software", and "We hereby
  irrevocably grant you an additional license to use the Software under the
  MIT license that is effective on the second anniversary of the date we make
  the Software available." This is the whole-repo lever against a hosted
  competitor, available to the copyright holder at any time.

### 2.5 Design references

- **GitHub's device flow** (docs.github.com, "Authorizing OAuth apps"): "This
  code is 8 characters with a hyphen in the middle", codes expire after "900
  seconds or 15 minutes", polling no faster than the server's `interval`. The
  approve-from-another-device method (§5.2) copies the shape: a short code
  shown on the new device, typed on a trusted one, a bounded poll.
- **Telegram's own confirmation box** (the login page): "Users are much more
  likely to authorize your app if the bot has a name and logo they recognize
  and expect." The bot the operator connects is named for the install, so the
  member sees the same name in Telegram and on the sign-in page.
- **Tailscale's sign-in page**: a short column of provider buttons, no
  password field, the product mark on top. The sign-in card in §6.6 has the
  same silhouette: one column, at most four actions, nothing to type unless a
  code is being entered.

## 3. The model

Every type below lives in `src/lib/team/contract.ts` (client-safe, no Node
imports) unless noted. Ids are opaque strings; names are what people see.

### 3.1 Member

```ts
export type MemberRole = "owner" | "member";
export type MemberStatus = "active" | "revoked";
export type MemberColor = TaskColor;             // the eight task colours, reused

export interface Member {
  id: string;                 // "m_" + 16 random bytes, hex. Never reused.
  name: string;               // 1–60 chars, what the chat shows. Renamable.
  handle: string;             // 2–24 chars, [a-z0-9-], unique; derived from name, editable
  role: MemberRole;
  status: MemberStatus;
  color: MemberColor;         // assigned round-robin at creation; editable
  grants: string[];           // empty in this slice; #634's capability vocabulary later
  telegram: { userId: string; username: string | null; firstName: string | null; linkedAt: string } | null;
  createdAt: string;
  createdBy: TeamActor;       // the owner who invited, or "claim", or "recovery"
  revokedAt: string | null;
  revokedBy: string | null;   // memberId
}
```

Exactly one member has `role: "owner"` in this slice. Revoking never deletes:
a revoked member's past attribution stays correct, and their handle stays
taken. The owner cannot be revoked; ownership transfer is deferred.

### 3.2 Session

```ts
export type SignInMethod = "claim" | "invite" | "approval" | "telegram" | "passkey" | "handoff" | "recovery";

export interface MemberSession {
  id: string;                 // sha256 hex of the cookie value; the value itself is never stored
  memberId: string;
  createdAt: string;
  lastSeenAt: string;         // refreshed at most once an hour
  expiresAt: string;          // absolute: createdAt + 180 days
  surface: RequestSurface;    // desktop | phone | tablet | other, from the User-Agent (src/lib/view/device.ts)
  browser: BrowserKind;       // chrome | safari | firefox | other
  method: SignInMethod;
  revokedAt: string | null;
  revokedBy: string | null;   // memberId, or "system" on member revoke
}
```

Cookie `llv_member`: 32 random bytes, base64url (43 chars); `HttpOnly`;
`SameSite=Lax`; `Path=/`; `Secure` when the request arrived over HTTPS (the
same `x-forwarded-proto` rule `llv_auth` uses); `Max-Age` 180 days. A session
is live when it is unrevoked, `expiresAt` is in the future and `lastSeenAt` is
within 30 days. Sign-in always mints a new value (rotation); a client-supplied
unknown value is never adopted. The proxy never adopts a session from
`Authorization`, from a query string or from any header.

### 3.3 Challenges: every short-lived code in one place

```ts
export type ChallengeKind = "invite" | "approval" | "telegram" | "handoff" | "passkey-register" | "passkey-sign-in" | "recovery";

export interface Challenge {
  id: string;
  kind: ChallengeKind;
  secretHash: string;         // sha256 hex of the code in the link; the code is 16 random bytes base64url
  userCode: string | null;    // approval only: 6 chars from "ABCDEFGHJKMNPQRSTUVWXYZ23456789", shown as "KJ7-4MP"
  memberId: string | null;    // handoff, passkey-*, telegram(link): the member it is for; invite: null
  createdBy: string | null;   // memberId of the issuer, when there is one
  createdAt: string;
  expiresAt: string;          // invite 7 d; approval, telegram, handoff 10 min; passkey-* 2 min; recovery 15 min
  consumedAt: string | null;  // single use; consumed atomically inside the collection mutation
  attempts: number;           // wrong user-code entries; 5 voids the challenge
  invitedName: string | null; // invite: the name the owner typed, prefilled for the joiner
  result: ChallengeResult | null;
}

export type ChallengeResult =
  | { kind: "telegram"; telegramUserId: string; firstName: string; username: string | null; memberId: string | null } // memberId null = unknown user
  | { kind: "approved"; byMemberId: string; bySessionId: string }
  | { kind: "denied" };
```

Codes carried in links are 128-bit random and unguessable; the only short
code is the approval `userCode`, which is voided after 5 wrong entries. A
challenge is consumed in the same `SqliteStateCollection` mutation that reads
it, so two racing redemptions cannot both succeed.

### 3.4 Passkey

```ts
export interface Passkey {
  id: string;                 // credential id, base64url
  memberId: string;
  rpId: string;               // the host it was registered on
  publicKey: string;          // COSE, base64url
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  label: string;              // "Chrome on desktop", editable
  createdAt: string;
  lastUsedAt: string | null;
}
```

Attestation `none`; `residentKey: "preferred"`; `userVerification:
"required"`. On a sign-count regression the sign-in still succeeds and a
`passkey.counter_regressed` event is written (synced passkeys legitimately
regress, as #20 §6.2 noted). At most 10 passkeys per member.

### 3.5 Storage

Five collections in `state.sqlite` through `SqliteStateCollection`
(`src/lib/state/sqliteStateStore.ts`), each opened lazily on first use and
never at import:

| collection | key | notes |
|---|---|---|
| `team_members` | `id` | ordered by `createdAt` |
| `team_sessions` | `id` (hash) | pruned on write: revoked or expired rows older than 30 days |
| `team_challenges` | `id` | pruned on write: expired rows older than 1 day |
| `team_passkeys` | `id` | |
| `team_events` | `id` | append-only; pruned to 90 days and 20 000 rows |

No secret is stored: session values are hashed, link codes are hashed, passkeys
hold public keys only. The collections therefore travel in the existing
`VACUUM INTO` backups without a new exception. Writers are the Viewer process
(routes) and, for `team_events` only, the MCP process (an agent's action is
recorded by the route it calls, so in practice the Viewer). Readers include the
MCP process (member names for `conversation_messages`), which already opens
`state.sqlite` for tasks.

Mode is a pure read: `teamMode()` answers `team` when `team_members` holds an
active owner, else `solo`, cached per process on the collection's revision.

### 3.6 The actor vocabulary

```ts
export type TeamActor =
  | { kind: "member"; memberId: string }
  | { kind: "agent"; conversationId: string; role?: string }
  | { kind: "service"; service: "monitor" | "mcp" | "orchestrator" | "runtime-host" | "cli" }
  | { kind: "operator" }          // solo mode: the unnamed local human, exactly today
  | { kind: "anonymous" };        // team mode, no session: refused at every stamp site
```

`teamActor(req)` in `src/lib/team/actor.ts` (server) resolves, in order: the
internal service tag → `service`; the spawn capability header
(`callerConversationId`) → `agent`; a live `llv_member` cookie → `member`;
otherwise `operator` in solo mode and `anonymous` in team mode. It never reads
`Authorization`, `Host` or `X-Forwarded-*`. `operatorAuthority.ts` keeps
answering its one question; `teamActor` is what the stamp sites ask instead of
"is this the operator".

### 3.7 Events

```ts
export type TeamEventAction =
  | "message.sent" | "question.answered"
  | "agent.started" | "agent.stopped"
  | "task.created" | "task.changed" | "task.hidden" | "task.shown"
  | "member.claimed" | "member.invited" | "member.joined" | "member.renamed" | "member.revoked" | "member.restored"
  | "join.requested" | "join.approved" | "join.denied"
  | "session.signed_in" | "session.signed_out" | "session.revoked" | "device.approved"
  | "passkey.added" | "passkey.removed" | "passkey.counter_regressed"
  | "telegram.linked" | "telegram.unlinked";

export interface TeamEvent {
  id: string;                 // <unix ms, 13 digits>-<8 random hex>: sorts by time
  at: string;
  actor: TeamActor;
  action: TeamEventAction;
  project: string | null;
  subject: { kind: "conversation" | "task" | "member" | "session" | "passkey"; id: string; title: string | null } | null; // title bounded to 120 chars
  detail: Record<string, string | number | boolean | null> | null;  // e.g. { field: "status", from: "inbox", to: "assigned" }; never message text
  via: RequestSurface | "mcp" | "telegram" | "cli";
}
```

`recordTeamEvent(req, event)` never throws and never refuses the action it
describes, the same contract as `recordOperatorRequest`.

## 4. The perimeter and the identity gate

### 4.1 Two layers

```
request ──► proxy: perimeter (LLV_TOKEN: cookie llv_auth | Bearer | ?k=) ──► identity gate (team mode only) ──► route
                    unchanged                                                    new                              stamp sites re-check
```

The perimeter answers "may this connection reach the Viewer". The identity
gate answers "which member is this browser". A solo install has no members
and the gate is a no-op; the request reaches the route as today and the stamp
sites record `operator`.

### 4.2 The gate in `src/proxy.ts`

After the token check passes (or when no token is configured), in team mode:

1. Exempt paths pass: `/sign-in`, `/join/*`, `/api/team/public`,
   `/api/team/session/*` (the sign-in endpoints), `/api/artifact/frame/*`
   (already exempt), `/_next/static`, `/favicon.ico`, `/brand/*`, `/icon.svg`,
   `/apple-icon`.
2. A request that names an agent (`x-llv-spawn-capability`, checked by shape
   only in the proxy; the registry lookup happens in the route) or carries the
   internal service tag passes: agents and services are not members.
3. A request that authenticated at the perimeter with `Authorization: Bearer`
   and is `GET` or `HEAD` passes: candidate readiness probes
   (`src/runtime-host/deploymentHealth.ts` sends the key and expects `200` at
   `/`), operator scripts that read, and browsers on the runtime host's trusted
   local entry (which injects the bearer). Such a browser loads the page and
   is sent to `/sign-in` by its first write (rule 5 at the stamp site), never
   by the page load.
4. A live `llv_member` cookie passes. The lookup is an in-process
   `Map<hash, {memberId, expiresAt, lastSeenAt}>` rebuilt when the
   `team_sessions` collection revision changes, so revocation is immediate
   and the per-request cost is one revision read.
5. Otherwise: a navigation (`Sec-Fetch-Mode: navigate`, or `Accept` preferring
   `text/html`) gets `307` to `/sign-in?next=<same-origin path>` (the `next`
   value is a path beginning with `/`, never a URL); everything else gets
   `401 { error: "sign in required", code: "member_required" }`. The SSE
   stream (`/api/logs/stream`) gets the same 401 and the client's existing
   reconnect path handles it (§4.4).

The proxy sets no header for downstream trust. Routes that need the member
call `teamActor(req)`, which verifies the same cookie against the same cache.
This is deliberate: #1496 was a header the caller controlled being treated as
evidence, and a proxy-set header is one accidental `NextResponse.next()`
away from being caller-controlled.

### 4.3 The stamp sites

Each site that today calls `directOperatorActivityAuthority(req)` and
`recordOperatorRequest` gains three lines: resolve `teamActor(req)`; in team
mode, if it is `anonymous` and the action is human-originated, answer
`401 member_required` before doing anything; pass the actor into the record it
writes and into `recordTeamEvent`. The sites are listed in §7 with their
records. An `agent` actor is refused exactly where it is refused today and
nowhere new.

### 4.4 The client

One place learns about `member_required`: `src/hooks/serverReach.ts` already
classifies failed fetches. A `401` with that code sets a `signInRequired`
flag; the Viewer shell renders a full-screen "Sign in to continue" panel with
one button that navigates to `/sign-in?next=<current path and hash>`. No
request is retried blindly, no message is lost: the composer keeps its draft
in the outbox row it already shows as "not sent", and the row's retry sends it
after sign-in.

`GET /api/team` (session required) is fetched once at boot beside the other
boot reads and answers `{ mode, me, members, methods }`. In solo mode it
answers `{ mode: "solo", me: null, members: [], methods }` and the client
renders nothing team-related.

### 4.5 Agents, MCP and the runtime host: unchanged

An agent still names itself by its spawn capability; the MCP server still
posts to the routes with that capability and the perimeter bearer; the
runtime host's entries still inject or require the release key. None of them
carries a member cookie and none needs one. `send_message` from an agent is
still stamped `origin: agent(role)`. The rotation, deploy and seat authorities
are untouched.

## 5. Sign-in methods

All methods end the same way: `createSession(memberId, method, req)` mints a
cookie, writes `session.signed_in`, and the response sets the cookie and
carries `{ ok: true, me }`. The page then navigates to `next` or `/`.

### 5.1 Invite link (owner → teammate)

The owner presses **Invite** on the Team page, optionally types the person's
name, and gets `https://<origin>/join/<code>` (7 days, single use) with a QR
and a Copy button. The link travels however the owner likes (the stage box's
owner already DMs credentials over Telegram). The teammate opens it on any
device: the page shows who invited them and asks for their name (prefilled
when the owner typed one). **Join** creates the member (`role: member`) and
the session. If the browser supports passkeys and the host is a domain, the
next screen offers **Add a passkey on this device** with **Not now** beside
it.

Why first: it is the universal method. No third party, no HTTPS, no phone
needed; it is also how the owner rescues a teammate who lost everything.

### 5.2 Approve from a signed-in device, and "sign in my phone"

**New device asks.** On `/sign-in`, **Approve from another device** shows a
code such as `KJ7-4MP`, the sentence "On a device where you are signed in,
open ⋯ → Team → Approve a device and enter this code", and a 10-minute
countdown. The page polls `GET /api/team/session/approval/<id>` every 3 s.

**Trusted device answers.** On the Team page, **Approve a device** takes the
code; the approver sees "Sign in <surface> as you?" with the requesting
browser's surface and browser name, and confirms. The new device's next poll
returns `approved`; it calls `POST /api/team/session/approval/<id>/complete`
and receives its cookie. The new device becomes **the approver's** identity:
this is "my other device", never "someone else's".

**Signing in the phone from the desktop** is the same mechanism, reversed and
folded into a gesture the product already has. In team mode the rail menu's
QR (`AccessQrButton`) asks `POST /api/team/session/handoff` for a 10-minute
code bound to the current member and draws the tailnet URL as
`https://<tailnet host>/join/<handoff code>?k=<token>`. One scan: the proxy
consumes `?k=` and sets `llv_auth`, redirects to `/join/<code>`, and the join
page redeems a `handoff` challenge by signing the phone in as that member. The
setup guide's phone step draws the same QR. In solo mode the QR is unchanged.

### 5.3 Telegram, through the bot

Available when the Telegram bot is connected in the Telegram panel
(`telegramBotService().status().connected`) and receiving.

**Sign in.** `/sign-in` → **Continue with Telegram**. The page asks
`POST /api/team/session/telegram` and gets `{ id, url:
"https://t.me/<bot>?start=<code>", expiresAt }`. On a phone the button opens
the link (the Telegram app opens the bot with a **Start** button); on a
desktop the page also draws the link as a QR for the phone's camera and shows
**Open Telegram** for the desktop app. The page polls
`GET /api/team/session/telegram/<id>` every 3 s.

**The bot hears it.** `TelegramBotService` gains one hook: before storing a
private-chat `message` whose text is `/start <param>`, it hands
`{ from, param }` to `teamTelegramHook` (a function the team module registers
at boot; absent in a build without the module). The hook finds the
unconsumed `telegram` challenge whose `secretHash` matches `sha256(param)`,
and records `result: { telegramUserId, firstName, username, memberId }` where
`memberId` is the member whose `telegram.userId` equals `from.id`, or null.
The message is then stored as usual (it is a normal DM), and the bot replies
in the chat: "Signed in to Delegatus as <name>." or "Delegatus does not know
you yet. <Owner name> can approve you from the Team page." (in the install's
interface language).

**Known user:** the poll returns `{ state: "confirmed", name }`; the page shows
"Signing in as <name>" for one beat and calls
`POST /api/team/session/telegram/<id>/complete` for the cookie.

**Unknown user:** the poll returns `{ state: "needs_approval", firstName }`.
The page says "Waiting for <owner name> to approve you"; a `join.requested`
event is written and the Team page shows a pending strip "<firstName>
(@username) asked to join · 2 min ago [Approve] [Deny]". **Approve** creates
the member with `telegram` linked and a name defaulting to the Telegram first
name; the next poll returns `confirmed`. The challenge's 10 minutes are
extended to 1 hour once a request is pending, so the owner has time; the
requester's page keeps polling while open and can be reopened from the same
link.

**Link my Telegram** (a signed-in member, Team page → own row → *Link
Telegram*) is the same deep link with `memberId` bound on the challenge; the
`/start` binds `from.id` to that member and writes `telegram.linked`. A
Telegram user id can be linked to one member; a second link attempt answers
"That Telegram account is already linked to <name>".

**What Telegram proves here.** Telegram delivered a message from user `from.id`
to the bot with this exact code. The code is 128-bit, single use, ten minutes.
The only way to sign in as someone else is to obtain their unexpired link
before they press Start, in which case the session goes to the requesting browser and never to the link
holder, and the page shows "Signing in as <name>": a member
who sees a name that is not theirs presses **That's not me**, which voids the
challenge and writes `join.denied`. The bot token never leaves
`src/lib/telegram/bot/transport.ts`.

### 5.4 Passkeys

**Offered when** `window.PublicKeyCredential` exists and the host is a domain
(not an IP). On `/sign-in` the button reads **Use a passkey**; the page asks
`POST /api/team/session/passkey/options` (no allow-list: discoverable
credentials let the browser present the member's passkeys for this RP ID),
calls `startAuthentication` from `@simplewebauthn/browser`, and posts the
assertion to `POST /api/team/session/passkey/verify`. The server looks the
credential id up in `team_passkeys`, checks `rpId`, verifies with
`verifyAuthenticationResponse` against expected origin `= request origin` and
expected RP ID `= request host`, updates the counter, and creates the session.
Conditional UI (`autocomplete="username webauthn"` on a hidden field) is a
nice-to-have the build may add if it costs under an hour; it is not required.

**Registering** happens from the Team page (own row → *Add a passkey on this
device*) and is offered once after joining. `POST /api/team/passkeys/options`
→ `startRegistration` → `POST /api/team/passkeys` stores the credential with
`rpId = request host` and a label derived from the User-Agent. Removing the
last passkey is allowed: the member still has the invite, approval and
Telegram paths, so no lockout rule is needed.

**Hosts.** Stage box: the DNS name Caddy serves. Tailscale: the MagicDNS name
the phone QR already uses (`LLV_TS_HOST`). Laptop: `localhost` works as an RP
ID and a secure context, though a solo install never shows the page.

### 5.5 Recovery from the host

`delegatus team recover` (a subcommand in `bin/cli.mjs`, claiming
`LLV_STATE_OWNER=tool` exactly as the other operator scripts do) writes a
`recovery` challenge (15 min, single use) and prints
`https://<origin>/join/<code>`: with an owner present it signs that browser in
as the owner; with no owner it turns the joiner into the owner. It also
prints `delegatus team revoke-sessions` as the "sign out everywhere" hammer.
On a Docker install the same command runs inside the release container
through the image's own `bin/cli.mjs`; the build lane documents the exact
`docker compose exec` line in the README's team section after confirming the
service name in `docker-compose.yml`.

### 5.6 Rejected

- **MTProto app with a shared `api_id`/`api_hash`**: grants the whole account
  (§2.1), and one app id for every install contradicts "obtain your own
  api_id for your application".
- **Telegram OIDC as the primary method**: needs a registered Allowed URL per
  install origin and a client secret in state; the bot deep link needs
  neither. Deferred (§14).
- **Passwords**: nothing to store, nothing to throttle, nothing to reset. Every
  install has at least the invite and approval paths, and the strong
  credential is the passkey.
- **A printed key pasted into the page**: #691 rounds 7–9; see D3.
- **Trusting loopback as the owner in team mode**: #1496 again on a shared box.
  The trusted local entry's bearer passes reads only (§4.2 rule 3).

## 6. Flows and screens

Dimensions: desktop 1440 × 900, phone 390 × 844. Tokens from
`docs/design/viewer-design-system.md`: type sizes caption 10 / label 11 / ui
12 / body 13 / title 15; radius control 8 / surface 12; surfaces canvas, card,
sunken, raised; the brand fill for the one primary action per screen; 44 px
touch targets on the phone. Copy is short, in sentences, without exclamation
marks, in en and uk.

### 6.1 The owner on their own machine

Nothing happens. The setup guide gains an optional **Team** step after Phone
(before Voice; `steps.team` in the onboarding marker, `null` when never
seen), with two cards:

```
┌ Team ──────────────────────────────────────────────────────────────┐
│  Who uses this Delegatus?                                          │
│                                                                    │
│  ( • ) Just me                 ( ) My team                         │
│        Nothing to set up.          Sign in as yourself, invite     │
│                                    others, see who did what.       │
│                                                                    │
│  [ Continue ]                                          Not now     │
└────────────────────────────────────────────────────────────────────┘
```

"Just me" is preselected. Continue with it writes `steps.team = "skipped"`
and changes nothing. "My team" reveals one field, **Your name**, and Continue
performs the claim of §6.2 for this browser.

### 6.2 The owner claims a shared install

The operator opens the Viewer on the stage box exactly as today (Caddy
password, then the `?k=` link). The install is in solo mode. In the ⋯ menu
the new row **Team** opens `/team`, which in solo mode is a single card:

```
┌─────────────────────────────────────────────┐
│   [emblem 48]                               │
│   Set up a team                             │
│   Sign in as yourself, invite others, and   │
│   see who did what.                         │
│                                             │
│   Your name  [ Mira                    ]  │
│                                             │
│   [ Set me as owner ]                       │
│                                             │
│   Other people who reach this Delegatus     │
│   will be asked to sign in from now on.     │
└─────────────────────────────────────────────┘
```

`POST /api/team/claim { name }` is allowed only in solo mode from a request
that would be the operator today (same origin, and neither an agent nor a service).
It creates the owner, creates this browser's session, writes
`member.claimed` and flips the mode. The response sets the cookie and the
page re-renders as the Members page (§6.9) with one row and the **Invite**
button focused. A second browser of the operator's now lands on `/sign-in`
and uses §5.2 (approve from this one) or a passkey.

### 6.3 Inviting a teammate

Team page → **Invite**:

```
┌ Invite someone ──────────────────────────────────────────┐
│  Their name (optional)   [ Oleh                      ]  │
│                                                          │
│  [ Create link ]                                         │
│                                                          │
│  ┌──────────────┐  https://dev.example.net:8443/join/…   │
│  │              │  [ Copy ]                              │
│  │     QR       │                                        │
│  │              │  Works once, for 7 days. Whoever opens │
│  └──────────────┘  it joins as a member.                 │
└──────────────────────────────────────────────────────────┘
```

Open invites are listed under the members with their expiry and a
**Withdraw** action. The link is never shown again after the dialog closes;
withdraw and reissue instead.

### 6.4 The teammate joins

`/join/<code>` (desktop and phone share one layout; the phone version is the
card at full width with 16 px margins):

```
┌────────────────────────────────────────┐
│  [emblem 48]                           │
│  Mira invited you to Delegatus       │
│                                        │
│  Your name   [ Oleh              ]   │
│                                        │
│  [ Join ]                              │
│                                        │
│  An expired or used link says so here  │
│  and offers nothing else.              │
└────────────────────────────────────────┘
```

After **Join**, once, on a domain host with passkey support:

```
┌────────────────────────────────────────┐
│  Signed in as Oleh                   │
│  Add a passkey on this device?         │
│  Next time, one touch signs you in.    │
│                                        │
│  [ Add a passkey ]        Not now      │
└────────────────────────────────────────┘
```

Then `/` (or `next`). The Members page now shows Oleh; the owner's board
does not change otherwise.

### 6.5 Signing in on a new device

`/sign-in` chooses its buttons from `GET /api/team/public`:
`{ mode, methods: { telegram: { available, botUsername }, passkey: { available: boolean, rpId }, approval: true }, hostName }`.
In solo mode the page redirects to `/` (there is nothing to sign in to).

### 6.6 The sign-in page

Desktop, 1440 × 900, on `--surface-canvas`, a 400 px card of
`--surface-card` with `--shadow-1`, vertically centred, `--radius-surface`:

```
                          ┌──────────────────────────────────────┐
                          │            [emblem badge 64]         │
                          │                                      │
                          │       Sign in to Delegatus           │   title 15 / 700
                          │       dev.example.net                │   label 11 / muted
                          │                                      │
                          │  [ ✈  Continue with Telegram      ]  │   brand fill, 40 px
                          │  [ ⚿  Use a passkey               ]  │   outlined, 40 px
                          │                                      │
                          │  ────────────  or  ────────────      │
                          │                                      │
                          │  [    Approve from another device ]  │   text button
                          │                                      │
                          │  Have an invite link? Open it here.  │   caption, muted
                          └──────────────────────────────────────┘
                                                        EN · UK        (language toggle, bottom-right of the page)
```

Rules: at most four actions; the primary (brand fill) is Telegram when
available, else the passkey, else the approval; a button that does not apply
is absent, never disabled; the host name is the request's own host, so a
member always knows which install they are signing into.

Phone, 390 × 844: the same card without the shadow, full width with 16 px
margins, 48 px buttons, the language toggle in the top-right corner, the
keyboard never needed on this screen.

**Approval sub-screen** (replaces the button column inside the card):

```
│  Approve from another device                 │
│                                              │
│           K J 7 – 4 M P                      │   28 px, tabular, letter-spaced
│                                              │
│  On a device where you are signed in, open   │
│  ⋯ → Team → Approve a device and enter this  │
│  code.                                       │
│                                              │
│  Expires in 9:41                    ‹ Back   │
```

On approval the card shows "Signed in as Mira" and navigates.

**Telegram sub-screen** (desktop shows the QR; the phone shows only the
button, since the app opens directly):

```
│  Continue with Telegram                      │
│  ┌────────┐  Scan with your phone, or        │
│  │   QR   │  [ Open Telegram ]               │
│  └────────┘  then press Start.               │
│  Waiting for Telegram…          ‹ Back       │
```

States: `waiting` → `confirmed` ("Signing in as Oleh") → navigate;
`needs_approval` ("Waiting for Mira to approve you. You can keep this page
open."); `denied`/`expired` ("This link expired. Try again.").

### 6.7 Chat with two named senders

`UserMessageRow` gains a `sender` prop `{ name, color, initials } | null`.
When present it draws a sender line above the bubble, right-aligned with it:

```
desktop (feed column)                                    phone (390)
                                     ● Mira                          ● Mira
                     ┌─────────────────────────────┐   ┌──────────────────────────────────┐
                     │ Review the auth seam again  │   │ Review the auth seam again       │
                     └─────────────────────────────┘   └──────────────────────────────────┘
  [Delegatus mark] Reviewer · 14:02                    Reviewer · 14:02
  ┌──────────────────────────────────────────────┐   …
  │ Looking at proxy.ts now.                     │
                                     ● Oleh                          ● Oleh
                     ┌─────────────────────────────┐
                     │ Check the Host pin too      │
```

The line: a 16 px circle (14 px on the phone) filled with the member's colour
(`TASK_COLORS` mapped through the same soft/strong pairs the card colour rule
uses) carrying the initials in `--text-caption` 700 on-brand ink, then the
name in `--text-label` 600 `--text-secondary`, 4 px gap, 2 px below the line
the bubble. The line is drawn on every human message in team mode, the
viewer's own included. A message with no member (sent before this slice, or
by a script) draws no line, never "Unknown". Agent relays keep the internal
card with the role pill; Viewer-authored cards keep the emblem.

The data path: the feed already fetches `/api/log/provenance`; its `messages`
and `occurrences` entries gain `sender: { memberId, name, color, initials }`
resolved server-side from the member record at read time (§7.1).

### 6.8 Who did what

`/team` → **Activity** tab:

```
┌ Team ───────────────────────────────────────────────────────────────────────────┐
│  Members   Activity   Sessions                              [ Approve a device ] │
│                                                                                 │
│  Everyone ▾    All projects ▾                                                    │
│                                                                                 │
│  Today                                                                          │
│  ● Oleh   started Reviewer            kestrel-cli                     14:02   │
│  ● Mira   sent a message              Reviewer · kestrel-cli          13:58   │
│  ● Mira   moved a task to Assigned    "Board undo/redo" · lantern     13:40   │
│  ● Oleh   answered a question         Builder · kestrel-cli           13:21   │
│  ⚙ Delegatus  revoked a session         Oleh · phone                  09:00   │
│                                                                                 │
│  Yesterday                                                                      │
│  ● Oleh   joined                                                      18:12   │
│  ● Mira   invited someone                                             18:05   │
│                                                                    Load more    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

One row per `team_events` record: avatar, name, verb phrase (from a closed
map of `action` → en/uk phrase), the subject (title or role, project), time.
A row whose subject is a conversation or task is a link to it. Rows carry no
message text and no details text. The phone renders the same list under the
same three tabs as a full-width page; the filters collapse into one **Filter**
button opening a `MobileSheet`.

### 6.9 Members and Sessions

**Members** tab:

```
│  Members   Activity   Sessions                     [ Approve a device ] [ Invite ] │
│                                                                                    │
│  ┌ Lesia (@lesia) asked to join · 2 min ago               [ Approve ]  [ Deny ] ┐  │
│                                                                                    │
│  ● Mira      owner    ✈ @mira   ⚿ 2   online · desktop            ⋯          │
│  ● Oleh      member   ✈ @oleh   ⚿ 1   seen 12 min ago             ⋯          │
│  ● Taras      member   —           ⚿ 0   never                        ⋯          │
│  ○ Roman        revoked                                          restore           │
│                                                                                    │
│  Open invites                                                                      │
│    Iryna · expires in 6 days                                      Withdraw          │
```

Row ⋯ (owner): Rename, Change colour, Revoke. Own row (any member): Rename,
Change colour, Link Telegram / Unlink, Add a passkey, and the passkey list
with labels and Remove. Revoke asks once ("Oleh will be signed out
everywhere and cannot sign in again. Their past messages keep their name.")
and writes `member.revoked` plus one `session.revoked` per live session.

**Sessions** tab (own sessions; the owner sees everyone's, grouped by member):
surface and browser, signed in via which method, created, last seen, this
device marked, **Sign out** per row and **Sign out everywhere**.

The ⋯ menu row **Team** appears in `RailHeaderMenu` after Activity and in
`onboardingMobileMenuEntries` after Dictation, on both form factors, in both
modes (in solo mode it opens the §6.2 card).

### 6.10 Signing out

Team page → Sessions → this device → **Sign out**, or the last row of the ⋯
menu in team mode (**Sign out · Mira**). `POST /api/team/session/sign-out`
revokes the session and clears the cookie; the page navigates to `/sign-in`.

## 7. Authorship: the records and the reads

### 7.1 Messages

Stamp site: `src/app/api/conversation-host/handlers.ts`, in
`recordAuthorizedOperatorActivity`. Today it decides `byOperator` from
`directOperatorActivityAuthority`. After: it resolves `actor = teamActor(req)`;
`anonymous` in team mode answers 401; `member` and `operator` both count as
"by a human". The `origin` passed to `enqueueStructuredMessage` /
`deliverConversationMessage` becomes `{ kind: "operator", memberId? }`:
`MessageOrigin` gains an optional `memberId` (marker-safe token), and
`parseMessageOrigin` accepts it.

Durable records:
- Codex: `StructuredUserMetadata.origin.memberId` in the per-delivery record
  (`src/lib/selection/structuredUserMetadata.ts`, version stays 1: the field
  is optional and absent on every existing record). The marker line in the
  transcript is unchanged; the agent's text is unchanged.
- Claude: the delivery ledger record's `origin` (`claudeStreamBrokerHost.ts`)
  carries the same optional `memberId`; `claudeMessageProvenance` passes it
  through.

Read: `DeliveredMessageProvenance` gains `sender?: { memberId: string; name:
string; color: MemberColor; initials: string }`, filled by
`/api/log/provenance` through `memberSummary(memberId)` (reads
`team_members`; a revoked member still resolves; an unknown id resolves to
nothing). The MCP `conversation_messages` record for a user message gains
`author: { kind: "member", name, handle } | { kind: "agent", role } | null`
from the same join, which is what makes #1497's "reading it through the MCP
tools still says who sent what" true.

Answering a question (`/api/answer`) writes `question.answered` with the
conversation as subject; the answer text itself already lands in the
transcript through the pane and carries no marker, so it is attributed in the
audit only.

### 7.2 Spawns

Stamp site: `src/lib/agent/spawnCommand.ts` where `recordOperatorRequest(kind:
"spawn")` runs. The registry conversation record (`RegistryConversation`,
`src/lib/agent/registry.ts`) gains an optional, additive `startedBy: TeamActor
| null`, written with the identity record the spawn already creates before
the process starts (#913). Reads: the card header's meta line shows a 14 px
avatar and first name in team mode; `get_conversation` and
`list_conversations` carry `startedBy`. Agent-started spawns carry `{ kind:
"agent", conversationId }`, which the board already knows as lineage; the
field simply names it in the same vocabulary. Event `agent.started` with the
new conversation as subject and the role in `detail`. Interrupt and kill on
`/api/proc` and the conversation-host dialog path write `agent.stopped`.

### 7.3 Tasks

Stamp sites: `src/app/api/tasks/route.ts` (create) and `[id]/route.ts`
(patch). `BoardTask` gains `createdBy?: TeamActor` and `updatedBy?: TeamActor`
with `updatedAt` (the latter already exists in the store's revisioning; the
field is added to the record if it is not exposed). The patch route computes
the changed fields it already validates and writes one `task.changed` event
with `detail: { fields: "status,text", from, to }` for status moves. Hide and
show through the board write `task.hidden` / `task.shown`; `TaskGroupHidden.by`
keeps its `"operator" | "agent"` shape and gains `memberId?`.

Reads: the card's meta row shows `updatedBy` (avatar + first name + relative
time) in team mode; `get_task` carries both fields. A task created by an agent
through MCP carries the agent actor, as its `origin` already implies.

### 7.4 Everything else

Member and session lifecycle, passkeys and Telegram links write their own
events from the team routes. Deploys, rotations and seat actions are not
stamped in this slice; their existing receipts name the triggering
conversation or "operator", and adding the member is a two-line change per
site listed in §14.

### 7.5 Old records

Nothing is migrated. A message, spawn or task with no actor field renders as
today, with no sender line and no meta avatar. The audit starts at the deploy
that ships this; the Activity tab's first day is that day.

## 8. Migration from today's token access

### 8.1 Path by path

| Today | After this design |
|---|---|
| Laptop, no token: open `http://127.0.0.1:8899/` | Unchanged. Solo mode. |
| Laptop, `--tailscale`: phone opens `https://<host>.ts.net/?k=…`, cookie set, done | Unchanged in solo mode. In team mode the QR carries `/join/<handoff>?k=…`: the phone is signed in as the scanning member in one scan. |
| Shared box: Caddy password → `?k=` → the app | Perimeter unchanged. In team mode, after the `?k=` redirect the browser lands on `/sign-in`; a member signs in once per device and stays signed in. |
| Runtime host trusted local entry (#1549): bearer injected for loopback-host requests | Unchanged. Reads pass the identity gate; the first write asks for sign-in. |
| MCP server → routes with `Bearer` + spawn capability | Unchanged; agents are not members. |
| Candidate readiness probe `GET /` with the key, expects 200 | Unchanged (§4.2 rule 3). |
| `delegatus --new-token` | Unchanged; rotates the perimeter key. Member sessions survive a key rotation, since they are a different layer. |
| The `llv_auth` cookie | Unchanged, 30 days, perimeter only. |
| `LLV_TS_HOST` in `sameOrigin.ts` | Unchanged; it is what admits the stage host name, and the sign-in POSTs pass through the same gate. |

### 8.2 What a solo user sees change

Nothing, unless they open ⋯ → Team, which shows the §6.2 card and can be
closed. `bun run build`, the CI Viewer runtime check (`GET /` → 200 with no
token) and every existing test run in solo mode by construction: no members
collection exists in a fresh state directory.

### 8.3 Cutover on the stage box

1. Deploy the release. The install is in solo mode; nothing changes for the
   people already using it.
2. The operator opens ⋯ → Team → **Set me as owner** from their usual browser.
   From this moment other browsers are asked to sign in; nothing is killed,
   no agent restarts (the memory note that any restart there kills agents
   applies to the deploy in step 1 and is unchanged by this design).
3. The operator creates one invite per teammate and DMs the links over
   Telegram as they did the passwords. Each teammate opens theirs once per
   device. Teammates who already talk to the install's bot can instead use
   **Continue with Telegram** and be approved from the Team page.
4. Caddy's `basic_auth` stays as the outer perimeter for as long as the
   operator wants it; it is now redundant with the identity layer and can be
   removed in a later step by deleting the block, which is outside this
   repository.
5. `delegatus team recover` on the box is the fallback if step 2's browser
   loses its cookie before a passkey or a second device exists.

### 8.4 Docker installs

`service.env` and the compose file are untouched. `state.sqlite` already lives
in the mounted state directory, so members and sessions survive deploys and
rollbacks; a rollback release that predates this design ignores the five
collections (they are additive) and runs in solo mode, which is what its
proxy knows.

## 9. Security notes

| Threat | Answer |
|---|---|
| Session theft from a backup or a state read | Only hashes are stored; the cookie value exists in the browser and in flight. |
| Session fixation / replay | New value on every sign-in; unknown values never adopted; single-use challenges consumed inside the collection mutation. |
| CSRF on sign-in and on every mutation | `rejectCrossOrigin` unchanged; `SameSite=Lax`; a cross-site POST cannot carry the cookie. |
| A header as evidence (#1496) | The gate reads a cookie the browser keeps and nothing the caller writes; no proxy-set trust header. |
| Guessing | Link codes are 128-bit; the approval code is 30 bits and voided after 5 wrong entries; passkeys are not guessable. No persistent throttle store: a Viewer restart resets the small in-memory counters, which is acceptable for 10-minute codes. |
| A stolen phone | Sessions tab → Sign out everywhere, or the owner revokes the member; both are immediate through the revision-keyed cache. |
| Lost passkey and lost phone | Invite from the owner; for the owner, the host CLI. |
| Leaked invite link | Single use, 7 days, withdrawable; the Members page shows who joined through it (`member.joined` names the invite). |
| Telegram link forwarded before Start | The requesting browser gets the session and shows the name; **That's not me** voids it. |
| The bot token | Never leaves its transport closure; the hook receives `from` and `param`, never the transport. |
| Same-uid local process | Unchanged and stated as before in `operatorAuthority.ts`: a process running as the operator's uid can read the browser's cookie jar; nothing in software on one uid closes that, and #691's five rounds established it. |
| Public exposure without a perimeter | Out of scope, as it is today: an install reachable from the internet still needs `LLV_TOKEN` or a proxy in front. The identity layer is not the perimeter (D1). A non-loopback bind without a token is the existing launcher guard's job (#1495). |
| Clickjacking of the sign-in page | The `(team)` layout sets `X-Frame-Options: DENY` on its own responses; the app's headers elsewhere are unchanged. |

## 10. Design language, copy and i18n

### 10.1 Visual

- The sign-in and join pages render outside the Viewer shell (route group
  `(team)` with its own minimal layout: canvas surface, the emblem, the
  language toggle) so a signed-out person never sees a board skeleton.
- The Team page renders inside the app like `/activity`: same rail, same
  header, three tabs in the page header. On the phone it is a full-width page
  reached from the ⋯ menu; sheets are used only for filters and confirmations.
- One brand-filled button per screen. Outlined secondary. Text tertiary.
- Avatars: a circle of the member's colour with initials; never a photo in
  this slice (Telegram's `picture` would be a hot link to Telegram's CDN from
  every viewer's browser, which the privacy posture of this app does not want
  by default).
- Reduced motion: the countdown and the "waiting" pulse respect
  `prefers-reduced-motion`.
- Contrast: initials on the eight colours use the same ink pairs
  `colorRule.ts`'s palette test already pins; the build adds the eight avatar
  pairs to `tokens.contrast.test.ts`.

### 10.2 Copy rules

Sentences, no exclamation marks, no "Welcome", no "Oops". The product name is
`PRODUCT_NAME`. A person is named by their `name`; the owner is "the owner"
only in explanations. Errors say what to do next in the same sentence.

### 10.3 i18n keys (namespace `team.*`, mirrored in `uk.ts`)

The build adds these keys; the en values are the strings in §6, the uk values
their mirror. Grouped:

- `team.menu` Team / Команда; `team.signOut` Sign out · {name} / Вийти · {name}
- `team.signIn.title` Sign in to Delegatus / Увійти в Delegatus;
  `team.signIn.telegram` Continue with Telegram / Продовжити через Telegram;
  `team.signIn.passkey` Use a passkey / Увійти з ключем доступу;
  `team.signIn.approval` Approve from another device / Підтвердити з іншого пристрою;
  `team.signIn.or` or / або; `team.signIn.inviteHint` Have an invite link? Open it here. / Маєте посилання-запрошення? Відкрийте його тут.;
  `team.signIn.approvalHint` On a device where you are signed in, open ⋯ → Team → Approve a device and enter this code. / На пристрої, де ви вже увійшли, відкрийте ⋯ → Команда → Підтвердити пристрій і введіть цей код.;
  `team.signIn.expiresIn` Expires in {time} / Спливає через {time};
  `team.signIn.telegramScan` Scan with your phone, or / Відскануйте телефоном або;
  `team.signIn.openTelegram` Open Telegram / Відкрити Telegram;
  `team.signIn.thenStart` then press Start. / потім натисніть Start.;
  `team.signIn.waiting` Waiting for Telegram… / Чекаємо на Telegram…;
  `team.signIn.signingInAs` Signing in as {name} / Входимо як {name};
  `team.signIn.notMe` That's not me / Це не я;
  `team.signIn.needsApproval` Waiting for {owner} to approve you. You can keep this page open. / Чекаємо, поки {owner} підтвердить вас. Цю сторінку можна лишити відкритою.;
  `team.signIn.expired` This link expired. Try again. / Посилання спливло. Спробуйте ще раз.;
  `team.signIn.required` Sign in to continue / Увійдіть, щоб продовжити
- `team.join.title` {inviter} invited you to Delegatus / {inviter} запросив(ла) вас у Delegatus;
  `team.join.name` Your name / Ваше ім’я; `team.join.join` Join / Приєднатися;
  `team.join.invalid` This invite was already used or has expired. Ask for a new one. / Це запрошення вже використане або спливло. Попросіть нове.;
  `team.join.passkeyOffer` Add a passkey on this device? / Додати ключ доступу на цьому пристрої?;
  `team.join.passkeyWhy` Next time, one touch signs you in. / Наступного разу один дотик — і ви увійшли.;
  `team.join.addPasskey` Add a passkey / Додати ключ доступу; `team.join.notNow` Not now / Не зараз
- `team.claim.title` Set up a team / Налаштувати команду; `team.claim.body` Sign in as yourself, invite others, and see who did what. / Увійдіть як ви, запросіть інших і бачте, хто що зробив.;
  `team.claim.name` Your name / Ваше ім’я; `team.claim.submit` Set me as owner / Зробити мене власником;
  `team.claim.consequence` Other people who reach this Delegatus will be asked to sign in from now on. / Відтепер інших людей, що відкривають цей Delegatus, проситимуть увійти.
- `team.onboarding.title` Who uses this Delegatus? / Хто користується цим Delegatus?; `team.onboarding.justMe` Just me / Лише я; `team.onboarding.justMeHint` Nothing to set up. / Нічого налаштовувати.; `team.onboarding.myTeam` My team / Моя команда; `team.onboarding.myTeamHint` Sign in as yourself, invite others, see who did what. / Увійдіть як ви, запросіть інших, бачте, хто що зробив.
- `team.tabs.members` Members / Учасники; `team.tabs.activity` Activity / Дії; `team.tabs.sessions` Sessions / Сеанси;
  `team.invite` Invite / Запросити; `team.approveDevice` Approve a device / Підтвердити пристрій;
  `team.invite.title` Invite someone / Запросити когось; `team.invite.name` Their name (optional) / Ім’я (необов’язково); `team.invite.create` Create link / Створити посилання; `team.invite.note` Works once, for 7 days. Whoever opens it joins as a member. / Діє один раз, 7 днів. Хто відкриє — стане учасником.; `team.invite.open` Open invites / Відкриті запрошення; `team.invite.expires` expires in {time} / спливає через {time}; `team.invite.withdraw` Withdraw / Відкликати;
  `team.request.asked` {name} asked to join · {age} / {name} просить приєднатися · {age}; `team.request.approve` Approve / Схвалити; `team.request.deny` Deny / Відхилити;
  `team.role.owner` owner / власник; `team.role.member` member / учасник; `team.role.revoked` revoked / відкликано;
  `team.presence.online` online · {surface} / онлайн · {surface}; `team.presence.seen` seen {age} / був(ла) {age}; `team.presence.never` never / ще не заходив(ла);
  `team.member.rename` Rename / Перейменувати; `team.member.color` Change colour / Змінити колір; `team.member.revoke` Revoke / Відкликати; `team.member.restore` Restore / Повернути; `team.member.revokeConfirm` {name} will be signed out everywhere and cannot sign in again. Their past messages keep their name. / {name} вийде на всіх пристроях і більше не зможе увійти. Минулі повідомлення збережуть ім’я.;
  `team.telegram.link` Link Telegram / Прив’язати Telegram; `team.telegram.unlink` Unlink / Відв’язати; `team.telegram.taken` That Telegram account is already linked to {name} / Цей Telegram уже прив’язано до {name};
  `team.passkey.add` Add a passkey on this device / Додати ключ доступу на цьому пристрої; `team.passkey.remove` Remove / Видалити; `team.passkey.count` {n} passkeys / {n} ключів (plural forms);
  `team.approve.title` Approve a device / Підтвердити пристрій; `team.approve.code` Code from the other device / Код з іншого пристрою; `team.approve.confirm` Sign in {surface} ({browser}) as you? / Увійти на {surface} ({browser}) як ви?; `team.approve.wrong` That code is not right. / Код неправильний.;
  `team.sessions.thisDevice` this device / цей пристрій; `team.sessions.signOut` Sign out / Вийти; `team.sessions.signOutAll` Sign out everywhere / Вийти всюди; `team.sessions.via` via {method} / через {method}; method names: `team.method.claim` setup / налаштування, `team.method.invite` invite link / посилання-запрошення, `team.method.approval` approved device / підтверджений пристрій, `team.method.telegram` Telegram, `team.method.passkey` passkey / ключ доступу, `team.method.handoff` phone QR / QR для телефона, `team.method.recovery` host recovery / відновлення з хоста;
  `team.activity.everyone` Everyone / Усі; `team.activity.allProjects` All projects / Усі проєкти; `team.activity.loadMore` Load more / Показати ще; `team.activity.empty` Nothing yet. Actions appear here as people take them. / Поки нічого. Дії з’являться тут, щойно хтось щось зробить.;
  action phrases `team.action.*` for every `TeamEventAction`: e.g. `message.sent` sent a message / надіслав(ла) повідомлення; `agent.started` started {role} / запустив(ла) {role}; `agent.stopped` stopped {role} / зупинив(ла) {role}; `task.created` created a task / створив(ла) задачу; `task.changed.status` moved a task to {to} / переніс(ла) задачу в {to}; `task.changed` edited a task / змінив(ла) задачу; `task.hidden` hid a task / приховав(ла) задачу; `member.joined` joined / приєднався(лась); `member.invited` invited someone / запросив(ла) когось; `member.revoked` revoked {name} / відкликав(ла) {name}; `session.revoked` signed out a device / вийшов(ла) з пристрою; `passkey.added` added a passkey / додав(ла) ключ доступу; `telegram.linked` linked Telegram / прив’язав(ла) Telegram; the remaining actions follow the same pattern.
- Bot replies (server-rendered in the install's interface language, in
  `src/lib/team/telegramSignIn.ts`, outside the browser dictionary):
  `Signed in to Delegatus as {name}.` / `Ви увійшли в Delegatus як {name}.`;
  `Delegatus does not know you yet. {owner} can approve you from the Team page.` / `Delegatus вас ще не знає. {owner} може схвалити вас на сторінці Команда.`;
  `Telegram linked to {name}.` / `Telegram прив’язано до {name}.`

The gendered Ukrainian past-tense forms use the `(ла)` convention already used
in the report renderer; the build may instead pick the form from a per-member
setting later (§14).

## 11. The module seam and the open-core recommendation

### 11.1 The seam

```
src/lib/team/                  server: store, sessions, invites, challenges, passkeys, telegramSignIn, events, actor, gate, avatar, contract.ts (types), i18n keys listed in §10.3
src/app/(team)/                sign-in and join pages with their own layout
src/app/team/                  the Team page route
src/app/api/team/**            every team route
src/components/team/**         SignInCard, JoinCard, ClaimCard, TeamStep, TeamPage, MembersList, InviteDialog, ApproveDeviceDialog, WhoDidWhat, SessionsList, MemberAvatar, SenderLine
```

Everything outside those directories that knows about the team is a **touch
point** that calls through `src/lib/team/contract.ts` and works when the
module answers "solo":

| Touch point | Call |
|---|---|
| `src/proxy.ts` | `teamGate(request)` → `pass \| redirect \| unauthorized` |
| `conversation-host/handlers.ts`, `spawnCommand.ts`, `tasks/route.ts`, `tasks/[id]/route.ts`, `answer/route.ts`, `proc/route.ts` | `teamActor(req)`, `recordTeamEvent(req, …)` |
| `structuredUserMetadata.ts`, `claudeStreamBrokerHost.ts`, `messageOrigin.ts` | the optional `memberId` field |
| `registry.ts` (`startedBy`), `tasks/types.ts` (`createdBy`, `updatedBy`) | the optional `TeamActor` field |
| `/api/log/provenance`, MCP `conversation_messages`, `get_task`, `get_conversation` | `memberSummary(memberId)` |
| `FeedItem.tsx`, `UserMessageRow.tsx`, the task card meta, the conversation card header | render `sender` / `updatedBy` / `startedBy` when present |
| `ProjectRail.tsx`, `menuEntries.tsx` | the Team row |
| `OnboardingDialog.tsx` | the Team step |
| `AccessQrButton.tsx`, `PhoneStep.tsx` | the hand-off code in the QR |
| `serverReach.ts`, the Viewer shell | `member_required` → the sign-in panel |
| `telegram/bot/service.ts` | `teamTelegramHook(from, param)` |
| `presenceStore.ts` | `memberId` on the stored view session |
| `bin/cli.mjs` | `team recover`, `team revoke-sessions` |
| `en.ts`, `uk.ts` | the `team.*` keys |

`contract.ts` exports a `nullTeam` implementation of the same interface
(`teamMode` → solo, `teamActor` → operator/agent/service, `teamGate` → pass,
`recordTeamEvent` → no-op, `memberSummary` → null). The build wires the real
implementation through one module, `src/lib/team/index.ts`; a build without
the directory would import `nullTeam` there. No other file decides.

### 11.2 The recommendation: one repository, MIT, team features in it

Not a closed edition, and not a fork. Reasons:

1. **There is no buyer today and there is a cost every week.** A fork kept in
   sync with a repository that lands several merges a day is a permanent
   rebase job. The operator's stated goal is a tool for their team and a team
   dashboard; the business model was raised as a question.
2. **Team features are the adoption story.** A single-user open-source
   Delegatus competes with every terminal multiplexer; a team one is the
   thing worth installing on a shared box. Withholding it from the public
   repository withholds the reason to try the product.
3. **MIT is not a moat either way.** Anyone can take the MIT core and add
   their own members module. What protects a small tool from a hosted
   competitor is a licence on the whole repository (FSL, BSL), which the
   operator as copyright holder can adopt at any time, and which is
   independent of where the team module lives.
4. **The seam keeps every option open.** If a paid edition is ever wanted, the
   move is the GitLab shape, in this repository: move `src/lib/team`,
   `src/app/(team)`, `src/app/team`, `src/app/api/team` and
   `src/components/team` under one directory (`ee/` or `team/`), put a
   licence file in it, keep `contract.ts` and `nullTeam` in the core, make
   `src/lib/team/index.ts` choose by a build-time flag (`LLV_EDITION=team`),
   and add a CI job that builds the core with the directory removed. That is
   about a day of work and no ongoing sync. Outside contributions to the core
   remain MIT and unaffected; contributions to the directory would need a
   contributor agreement, which is the one new obligation.
5. **What the move would NOT give:** enforcement. A directory licence in a
   public repository is a statement of terms, exactly as GitLab's is; it
   relies on the buyer's compliance, and it does nothing against someone who
   reimplements the same 3 000 lines. The revenue path for a tool like this
   is hosting, support and the shared stage-box shape (a managed install per
   team), which the code does not need to be closed for.

So: build it here, under MIT, behind the seam, and revisit the licence of the
whole repository if and when a competing hosted product appears.

## 12. File list

New:

```
src/lib/team/contract.ts             types (§3), the TeamContract interface, nullTeam
src/lib/team/index.ts                the wired implementation; the only file that chooses
src/lib/team/store.ts                the five collections, migrations, pruning, teamMode()
src/lib/team/sessions.ts             mint, verify (cache keyed by collection revision), touch, revoke, cookie helpers
src/lib/team/challenges.ts           issue / redeem / void; user-code alphabet; attempts
src/lib/team/invites.ts              invite + join + claim + recovery
src/lib/team/approval.ts             approve-from-device and hand-off
src/lib/team/telegramSignIn.ts       deep-link challenges, the bot hook, bot replies
src/lib/team/passkeys.ts             SimpleWebAuthn wrappers, rpId/origin from the request
src/lib/team/events.ts               recordTeamEvent, readTeamEvents (cursor, filters)
src/lib/team/actor.ts                teamActor(req)
src/lib/team/gate.ts                 teamGate(request) for the proxy
src/lib/team/avatar.ts               initials, colour assignment
src/lib/team/http.ts                 route helpers: requireMember, requireOwner, json errors
src/app/(team)/layout.tsx            minimal layout, X-Frame-Options
src/app/(team)/sign-in/page.tsx
src/app/(team)/join/[code]/page.tsx
src/app/team/page.tsx
src/app/api/team/route.ts                       GET (session): mode, me, members, methods
src/app/api/team/public/route.ts                GET: mode, methods, hostName
src/app/api/team/claim/route.ts                 POST
src/app/api/team/invites/route.ts               POST (owner), GET (owner)
src/app/api/team/invites/[id]/route.ts          DELETE (owner)
src/app/api/team/join/[code]/route.ts           GET (preview), POST (join / handoff / recovery redeem)
src/app/api/team/join-requests/[id]/route.ts    POST approve|deny (owner)
src/app/api/team/members/[id]/route.ts          PATCH name|color|revoke|restore
src/app/api/team/session/approval/route.ts      POST start
src/app/api/team/session/approval/[id]/route.ts GET poll, POST complete
src/app/api/team/session/approve/route.ts       POST (session): approve by user code
src/app/api/team/session/telegram/route.ts      POST start (sign-in or link)
src/app/api/team/session/telegram/[id]/route.ts GET poll, POST complete, DELETE not-me
src/app/api/team/session/passkey/options/route.ts, verify/route.ts
src/app/api/team/session/handoff/route.ts       POST (session)
src/app/api/team/session/sign-out/route.ts      POST
src/app/api/team/sessions/route.ts              GET; /[id] DELETE; /all DELETE
src/app/api/team/passkeys/options/route.ts, route.ts (POST store, GET list), [id]/route.ts (DELETE, PATCH label)
src/app/api/team/events/route.ts                GET ?member=&project=&cursor=
src/components/team/SignInCard.tsx, JoinCard.tsx, ClaimCard.tsx, TeamStep.tsx, TeamPage.tsx, MembersList.tsx, InviteDialog.tsx, ApproveDeviceDialog.tsx, WhoDidWhat.tsx, SessionsList.tsx, MemberAvatar.tsx, SenderLine.tsx
```

Touched (one line each):

```
src/proxy.ts                                     call teamGate after the token check
src/lib/runtime/messageOrigin.ts                 optional memberId on the operator origin; sender on provenance
src/lib/selection/structuredUserMetadata.ts      persist memberId
src/lib/runtime/claudeStreamBrokerHost.ts        persist memberId on the ledger record
src/lib/runtime/claudeMessageProvenance.ts       pass it through
src/app/api/log/provenance/route.ts              join sender
src/app/api/conversation-host/handlers.ts        teamActor, refuse anonymous, stamp, event
src/lib/agent/spawnCommand.ts                    same; startedBy
src/lib/agent/registry.ts                        optional startedBy on RegistryConversation
src/app/api/tasks/route.ts, [id]/route.ts        createdBy / updatedBy, events
src/lib/tasks/types.ts                           the two optional fields; memberId on TaskGroupHidden
src/app/api/answer/route.ts, src/app/api/proc/route.ts   events
src/lib/mcp/bindings.ts                          author on conversation_messages; startedBy, createdBy/updatedBy passthrough
src/components/feed/FeedItem.tsx, UserMessageRow.tsx     sender line
src/components/… task card meta, conversation card header   updatedBy / startedBy
src/components/ProjectRail.tsx, onboarding/menuEntries.tsx  Team row; Sign out row
src/components/onboarding/OnboardingDialog.tsx   Team step; src/lib/onboarding/marker.ts: steps.team
src/components/AccessQrButton.tsx, onboarding/PhoneStep.tsx   hand-off code in the QR
src/hooks/serverReach.ts, src/components/Viewer.tsx         member_required → sign-in panel
src/lib/telegram/bot/service.ts                  the /start hook
src/lib/view/presenceStore.ts, view/types.ts     memberId on StoredViewSession
bin/cli.mjs                                      team recover, team revoke-sessions
src/lib/i18n/en.ts, uk.ts                        team.* keys
package.json                                     @simplewebauthn/server 14.0.3, @simplewebauthn/browser 14.0.0
README.md                                        a Team section (sign-in methods, recovery command)
```

## 13. Build plan

Three slices, each a pull request with its own rendered evidence. Every test
named is verified RED against the code it guards before it goes green
(`git show HEAD:file` or a merge-base worktree, never a stash).

### Slice 1: members, sessions, the gate, invite and approval, the Team page

- `src/lib/team/*` except passkeys and telegram; the proxy gate; the
  `(team)` pages with the invite, approval and hand-off paths; `/team` with
  Members and Sessions; the claim card; the onboarding step; the menu rows;
  the sign-out row; the CLI subcommands.
- Tests: `store.test.ts` (collections, pruning, mode); `sessions.test.ts`
  (mint/verify/rotate/expire/revoke, revision-keyed cache invalidation across
  two collection handles); `challenges.test.ts` (single use under a
  concurrent redeem, user-code attempts); `gate.test.ts` (the matrix: solo /
  team × exempt path / agent header / service tag / bearer GET / bearer POST /
  cookie valid / cookie revoked / navigation / fetch / SSE); `proxy.test.ts`
  additions; route tests for claim (refused in team mode, refused for an
  agent), invite/join (expired, used, withdrawn), approval (wrong code ×5
  voids), hand-off (`/join/<code>?k=` end to end through the proxy);
  `cli.team.test.ts` for `recover` under an operator-shaped home
  (`stateOwnership.entryPoints.test.ts` gains the new subcommand);
  `stateOwnership`: no team module resolves state at import
  (`bun run build` with an isolated config root proves it).
- Acceptance (from #1497): two browsers, two members, both reload and open a
  new tab without re-entering anything; a solo state directory shows no
  change on any screen; revoking a member returns 401 on their next write.

### Slice 2: authorship and the sender line

- The four stamp sites, the three record fields, provenance `sender`, MCP
  `author` / `startedBy` / `createdBy` / `updatedBy`, `SenderLine`, the card
  meta, `team_events` and the Activity tab.
- Tests: `conversation-host` route test asserting `memberId` reaches the
  metadata record and the ledger; `claudeMessageProvenance.test.ts` and
  `structuredUserMetadata` tests for the optional field, including a
  pre-slice record decoding byte-identically; `provenance` route test for the
  join and for a revoked member; MCP `conversation_messages` test for
  `author`; `spawnCommand` test for `startedBy`; task route tests for
  `createdBy`/`updatedBy` and the `task.changed` detail; `events.test.ts`
  (cursor, filters, retention); a `FeedItem` DOM test that a message with a
  sender draws the line and one without draws nothing; the kanban browser
  test (`kanbanBoard.browser.test.tsx`) gains one `describe` for the meta
  avatar; the mobile browser test gains the sender line at 390.
- Acceptance: a third browser sees two distinct names on two messages; the
  same conversation over `conversation_messages` says the same; an agent's
  relay still renders as the internal card.

### Slice 3: Telegram and passkeys

- `telegramSignIn.ts`, the bot hook, join requests and the pending strip;
  `passkeys.ts`, the two option/verify pairs, the passkey list, the post-join
  offer.
- Tests: `telegramSignIn.test.ts` with the existing `fakeTransport` (a
  `/start <code>` update for a known user confirms; for an unknown user
  creates a request; a stale code does nothing; the bot reply text in both
  languages; the token never appears in any record); `passkeys.test.ts`
  reproducing the §2.2 round trip under Bun with a WebCrypto key, plus a
  tampered signature, a wrong RP ID, a counter regression (allowed, event
  written), and a credential registered on another host not offered.
- Acceptance: a phone signs in through the Telegram app with the bot; a
  desktop on the stage host name registers and uses a passkey.

### Gates for every slice

`bunx tsc --noEmit`; touched tests by path under Bun 1.4.0 with an isolated
config root; `bun run build` with an isolated config root; the privacy gate;
each heavy gate wrapped in `flock /var/tmp/llv-heavy-gate.lock`.

### Rendered evidence

Renders go under `~/Pictures/delegatus-review/sign-in/`, never committed, at
1440 × 900 and 390 × 844, en and uk, from a production build under a seeded
neutral home with invented members:

```
sign-in-desktop-{en,uk}.png, sign-in-phone-{en,uk}.png
sign-in-approval-desktop-{en,uk}.png, sign-in-telegram-desktop-{en,uk}.png, sign-in-telegram-phone-{en,uk}.png
join-desktop-{en,uk}.png, join-phone-{en,uk}.png, join-passkey-offer-phone-{en,uk}.png
claim-desktop-{en,uk}.png
invite-dialog-desktop-{en,uk}.png, invite-dialog-phone-{en,uk}.png
chat-two-senders-desktop-{en,uk}.png, chat-two-senders-phone-{en,uk}.png
team-members-desktop-{en,uk}.png, team-members-phone-{en,uk}.png
team-activity-desktop-{en,uk}.png, team-activity-phone-{en,uk}.png
```

The reviewer measures at 390: no control narrower than 44 px, no clipped
name, the code readable at arm's length, no overlap between the sender line
and the bubble at the longest fixture name (24 characters).

## 14. Deferred: not currently justified

- **Telegram OIDC ("Telegram Login" popup)**: one-tap sign-in on installs with
  a registered public origin. Needs a client secret in state and an Allowed
  URL per origin. Add when an install wants it; `telegramSignIn.ts` gets a
  second entry point, nothing else changes.
- **Telegram profile photos** as avatars: hot-linking Telegram's CDN from every
  viewer; would need a proxying route and a cache.
- **Per-member interface language and time zone**: today one setting per
  install (`operator/settings.ts`); the reports and the seat read it. A
  member field plus a resolution order is straightforward but changes what
  agents read, so it is its own lane.
- **The capability matrix** (#634: `task:manage-others`,
  `account:select-privileged`, `orchestrator:control`, …) and per-project
  membership. `grants: []` is on the member for it.
- **Ownership transfer and several owners.**
- **Attribution on deploys, rotations, seat actions, pipeline actions and the
  Telegram bridge directives**: two lines per site once the vocabulary exists;
  each site is a control with its own receipt today.
- **Presence roster, halos and ghost cursors** (#634 slice 1): `memberId` on
  the stored view session is the only preparation taken.
- **Board-room human chat** (#634 slice 2).
- **Password sign-in, TOTP, one-time recovery codes, persistent throttle
  store, public-mode fail-closed startup** (#20): the requirement has a
  perimeter on every install it names; these belong to public exposure
  without one, which is #20's own scope.
- **Prefixing the sender's name into the agent's prompt** ("Oleh: …"):
  useful once several humans talk to one agent in a session; the marker has
  room for a `by=` attribute. Not asked for.
- **Session device names from client hints** and geo: the User-Agent surface
  and browser are enough for the Sessions tab.
- **An `ee/` directory licence or a whole-repo FSL**: §11 explains when.

## 15. Validation against the quote

| Asked | Where |
|---|---|
| Each person signs in as themselves | §3.1, §5, §6.4–6.6 |
| Linking the account to Telegram if it makes sense | §5.3, decided in D5 with §2.1 |
| Who sent which request, who started which agent, who changed which task | §7.1–7.3, the records; §6.8, the view |
| The chat shows the sender's name on human messages | §6.7, D10 |
| Works on the shared stage server as well as on the operator's machine | §8.3 cutover; §8.2 solo unchanged; passkeys on the stage host name §5.4 |
| Open-core: decide and explain; build behind a clean boundary; say what the move takes | §11, D11 |
| Telegram: verify capabilities and terms from primary sources; do not grant the full account | §2.1, §5.6 |
| Decisions with reasoning | the decisions table, and each section's "why" |
| Member/session/authorship model | §3, §7 |
| First-run flow for the owner and for inviting a teammate | §6.1–6.4 |
| How existing token access keeps working | §8.1 |
| Audit trail of who did what | §3.7, §6.8 |
| Working module: sign-in page and flows, members and sessions (revocable), authorship stamped, sender shown, who-did-what view, en and uk, desktop and phone | §13, three slices; this document is the design half of the deliverable, and the slices are the build half |
| Keep single-user local use frictionless | D2; §8.2 |
| #1497 acceptance: two people, distinct authors to a third; survives reload and new tab; solo sees no step; durable and readable over MCP; revocation stops new messages and keeps old attribution | §13 slice 1 and 2 acceptance; §3.1 "revoking never deletes"; §7.1 MCP `author` |
