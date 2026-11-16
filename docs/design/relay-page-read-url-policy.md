# Relay page reading: a guarded reader and its URL policy

Status: design, 2026-11-16. Code read on `2788b2c0f6` (main). Line references
are to that revision.
Bare file names are under `src/lib/externalRelay/`, except `ephemeral.ts`
(`src/lib/agent/`), `sameOrigin.ts` and `publicOrigin.ts` (`src/lib/`),
`self.ts` (`src/lib/links/`) and `phoneAccess.ts` (`src/lib/access/`).

## Originating requirement

- 2026-10-19, the operator's standing instruction (paraphrased): every bug and
  every unfinished piece of work is filed and fixed.
- 2026-11-03, the operator (paraphrased, relayed by an agent): the restricted
  relay's native web search must work properly for ordinary chat members. The
  incident behind it: a member asked where to get Delegatus; the relay agent
  ran one search, got unrelated results and answered that nothing exists.
- #3632 (`6bf8b958`) shipped general search guidance and resumed-context
  recovery. Page reading was deferred the same night: Claude's `WebFetch`
  fetches from this machine, and Codex's provider-side opens have no host
  denylist. Source: this lane's board task (a continuation of the
  relay-search task) and #3632.

**Should this be built?** Yes. The requirement names it, and the guidance
#3632 ships already tells every engine to "Open relevant result pages and read
them" (`src/lib/externalRelay/searchGuidance.ts:3`), which a Claude relay
answer cannot do today.

## How the restricted relay searches today

Every requester gets `{ webSearch: true }` (`profile.ts:22-26`); the runner
passes it to each engine (`runner.ts:713`, `:1064`). #3632 added the guidance
to the first prompt, tool rounds, chain turns and owner prompts
(`prompt.ts:39`, `:96`, `ownerRun.ts:138`, `:187`, `:261`) and fixed the resume
cursor (`prompt.ts:86-96`). It enabled no fetching.

| Path | Launch | Page opens today |
|---|---|---|
| Claude, local | `--restricted --safe-mode --tools WebSearch --allowedTools WebSearch --strict-mcp-config` (`ephemeral.ts:210-230`). The init tripwire requires exactly `StructuredOutput` and `WebSearch`, and any other `tool_use` stops the run (`progress.ts:46-69`). | None. `WebSearch` takes a query and has no URL input; `WebFetch` is not offered. |
| Codex, local | `codex exec` with shell, apps, plugins, browser and computer use disabled and `-c web_search=cached` (`ephemeral.ts:251-313`). The tripwire admits search items (`progress.ts:18-30`); page reads use `read_page`. | Provider-side live page opens are disabled. |
| Codex Cloud, non-owner | `thread/start` with the same features off and `web_search: "cached"` (`cloud.ts:103-115`). | Provider-side live page opens are disabled; page reads use `read_page`. |
| Owner tier, prototype answers | A full ordinary agent (`relay-owner-tier.md`); a prototype answer has no web. | Out of scope. |

Codex opens happen at the provider. Its tool config offers only an
`allowed_domains` allowlist (`src/lib/accounts/protocol/0.167.0/stable.json`,
`WebSearchToolConfig`), so no launch flag can deny this installation's hosts.
This machine's interactive Codex sessions in 2026 (408 rollout files with web
search items) hold 302 searches and 921 provider opens (`openPage`,
`findInPage`, `other`). 915 opens carry URLs; 6 carry none.

## Options

| Option | Verdict |
|---|---|
| Offer Claude's `WebFetch` | Rejected. It fetches from this machine. The only in-CLI enforcement point is a hook, which §B.6.3 of `relay.md` excludes, and its DNS and redirects stay inside the CLI. |
| `WebFetch` behind a guarded forward proxy (`HTTPS_PROXY`) | Rejected as over-built: a long-lived CONNECT proxy in the Viewer that also carries model API traffic, with per-tool proxy behaviour unverified. |
| A reader MCP server attached to each engine | Rejected. It breaks the "no MCP servers" hardening and its tripwires (`relay.md` §B.6.1, `progress.ts:55`), and a remote Cloud turn cannot reach a local stdio server. |
| **`read_page`, a local tool in the existing relay tool loop, run by the Viewer** | **Chosen.** Engine tool surfaces stay byte-identical. It works on all three paths because the loop already drives Claude, Codex and Cloud rounds (`runner.ts:936-1118`). Cost: a read takes one more round. |
| **Provider opens: switch restricted Codex search to `web_search=cached`** | **Chosen after review.** It disables provider-side live page fetches. `read_page` is the sole page reader and applies policy before every request. |

## The reader

`src/lib/externalRelay/pageReader.ts`, `readPublicPage(url, { signal, deadlineAt })`,
built by `createPageReader({ resolve, dial, interfaces })`. Production uses
the system resolver and direct dialling. Tests inject them through
`runtime.pageReader`, the same seam style as `runtime.cloudTransport`
(`runner.ts:180`). Request input can never select them.

- **Connect by the checked address.** `http(s).request({ hostname: <checked
  IP>, port, servername: <DNS name only>, headers: { host }, agent: false })`, the
  pinned pattern of `readRelayBytesUrl` (`client.ts:327-345`). The URL check
  runs inside this dial step, so no caller checks a URL and hands it on, and
  DNS cannot change between check and connect. TLS verifies DNS hosts against
  SNI and IP literals against their IP subjectAltName with the default CAs.
- **No `fetch`.** On Bun 1.4.0 (the `Dockerfile` pin) a probe on this machine
  sent `fetch` to an IP literal through `HTTP_PROXY`, while `node:http` with
  `agent: false` connected directly.
- **Request.** `GET` only. Headers: `Host`, `User-Agent: Delegatus-PageReader/1`,
  `Accept`, `Accept-Encoding: gzip, br, identity`. No cookies, `Authorization`,
  `Referer` or relay credential. The fragment is dropped.
- **Redirects.** 301, 302, 303, 307 and 308 with `Location` are resolved
  against the current URL. Each hop is checked and dialled like the first. At
  most 5 hops (`too_many_redirects`).
- **Response.** Final status 200 (else `http_status`). `text/html` and
  `application/xhtml+xml` go through Bun's `HTMLRewriter`, which keeps the
  title and text and drops `script`, `style`, `noscript`, `template`, `svg` and
  `iframe` contents. `text/plain`, `text/markdown` and `application/json` stay
  as text. Anything else is `unsupported_content`. The charset comes from
  `Content-Type`, with UTF-8 as the default.
- **Bounds.** 2 MiB of decoded body (decompressed bytes count). 16 KiB of text
  per page, with `truncated: true` past it; the loop's 64 KiB result budget
  bounds a request (`toolLoop.ts:319-328`). DNS 3 s, connect and headers 8 s,
  body 10 s, at most 20 s per call and never past the request deadline. No
  cache. The call runs under `withViewerOperation("relay.page-read")`.
- One document is fetched. No subresources, frames, scripts, sockets or
  workers.

## The URL policy

`src/lib/externalRelay/pageUrlPolicy.ts`, `checkPageUrl(url, { resolve,
interfaces })` returns `{ url, addresses }` or a refusal. It is applied to the
requested URL, to every redirect hop and to every provider open. Checks run in
this order; the first failing one names the class:

1. Parse with WHATWG `URL`, at most 2048 characters. `URL` already folds
   `2130706433` and `0x7f.1` to `127.0.0.1` (observed on Bun 1.4.0). A parse
   failure is the error `invalid_url`.
2. Scheme `http:` or `https:` → else `scheme`.
3. No user name or password → else `credentials`.
4. Host name, lowercased by `URL`, trailing dot removed: `localhost` or
   `*.localhost` → `loopback`; an installation name → `installation_host`.
5. An IP literal → the address classes below.
6. Port: the scheme's default only (80, 443) → else `port`.
7. DNS: resolve every configured installation name and then the requested
   host with `dns.lookup(name, { all: true, verbatim: true })`. Installation
   names include the public host, public origin, transport host, `HOSTNAME`
   and the machine hostname. The full set of lookups shares a 3-second
   deadline; each answer set is limited to 32 valid IP addresses. An
   unresolvable or malformed installation answer refuses with
   `installation_unverifiable`. Every resolved installation address is added
   to the installation-address block list, including IPv4-mapped IPv6 forms.
   No answer for the requested host is `unreachable`. **Every** requested DNS
   answer is classified, and one refused answer refuses the URL. The reader
   then dials one of these checked answers.

**Address classes**, one `net.BlockList` each, checked in this order (Bun
1.4.0 matched IPv4 rules for `::ffff:`-mapped addresses in a probe, so a mapped
address gets its IPv4 class):

| Class | IPv4 | IPv6 |
|---|---|---|
| `installation_address` | every address in `os.networkInterfaces()` and configured public installation hosts that are IP literals | same, including mapped IPv4 equivalence |
| `loopback` | 127.0.0.0/8 | ::1 |
| `unspecified` | 0.0.0.0/8 | :: |
| `link_local` | 169.254.0.0/16 | fe80::/10 |
| `private` | 10/8, 172.16/12, 192.168/16, 100.64/10 (shared space, used by tailnets) | — |
| `unique_local` | — | fc00::/7 (tailnets use fd7a:115c:a1e0::/48) |
| `reserved` | 192.0.0/24, 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4 | anything outside 2000::/3 (NAT64 64:ff9b::/96, multicast), 2001::/32, 2001:db8::/32, 2002::/16 |

**Installation names** are read from the environment on every check, with no
file read on the hot path: `LLV_PUBLIC_HOST` (the saved link address,
`self.ts:167`, `phoneAccess.ts:440`), the host of `LLV_PUBLIC_ORIGIN` whether
or not the access key admits it (`publicOrigin.ts:3-15`), `LLV_TS_HOST`,
`HOSTNAME` (`sameOrigin.ts:44-49`) and `os.hostname()`. These names are refused
directly and their DNS answers are blocked as installation addresses, so
public IP access and DNS aliases for a NAT or reverse-proxy endpoint are
refused before dialing. If a configured installation name cannot be resolved
within the shared deadline, page reading fails closed with
`installation_unverifiable`. A pasted signed link of this installation is
refused by name.

**Installation ports.** The default-port rule refuses 8898, the remote entry,
`PORT` and every other local service port on every host. Ports 80 and 443 on
this machine's own addresses fall to `installation_address` or `loopback`.

**Measured on real data before the cached-search restriction:** the 2,600 URLs
of the 921 provider opens above. Checks 2-6 refused none: no other scheme, no
credentials, no non-default port, no refused IP literal, no installation name.
Check 7 was not measured, because it needs live lookups.

### Provider opens

Restricted Codex search uses cached results so it cannot fetch arbitrary
result pages from the provider. Pages are opened only by the local `read_page`
tool. The round-end event check remains defense in depth: any reported provider
open is checked, and a refusal discards the round.

- **Collected.** Codex local: `item.started` and `item.completed` with
  `item.type === "web_search"` (`progress.ts:18-30`). Codex Cloud:
  `item/completed` with `item.type === "webSearch"` (`cloud.ts:83-91`; schema
  in `protocol/0.166.0/stable.json`, `WebSearchThreadItem`). For any action
  other than `search`, the open's URLs are `action.url` plus every
  `results[].url`, which can show where a redirect landed. Unknown action types
  count as opens. An open with no URL, or more than 16 distinct hosts in a
  round, is `unverifiable_open` (6 of 921 real opens, 0.65%).
  A started item with no URL remains pending until its matching completed item
  identifies the action: a completed search clears only that pending placeholder,
  a completed open replaces it, and an unmatched placeholder is unverifiable.
  URLs already present on a started item stay subject to the policy even if a
  later item claims to be a search.
- **Checked** with checks 1-7, without connecting, at round end, before the
  answer is read (`runner.ts:1230`).
- **Notes.** After a round's first open, its note progress is not forwarded
  (`runner.ts:1067-1075`), so a note cannot quote the page before the check.
- **On refusal** the round's answer is discarded: no reply, no calls, no
  actions. If the round ran in a fresh process (no chain session) and was not
  the final one, the refusal goes into the next round's `<tool_results>`.
  Otherwise (a chain session holds the page, the final round, or guest
  delivery) the result becomes `violation`. That reuses the existing outcome
  `failed` / `profile_violation` (`runner.ts:1285-1288`) and breaks the chain
  conversation (`runner.ts:1220`). The wire protocol does not change.

## Routing per engine

| Path | `read_page` | Provider opens | Native tools after the change |
|---|---|---|---|
| Claude, local | loop tool | none exist | `StructuredOutput`, `WebSearch`, unchanged |
| Codex, local | loop tool | gated from stdout items | unchanged |
| Codex Cloud, non-owner | loop tool; rounds resend `<tool_results>` (`runner.ts:958`, `:1078-1118`) | gated from socket items | unchanged |
| Cloud → local fallback (`cloud.ts:160-168`) | as Codex local | as Codex local | unchanged |
| Guest delivery | not offered: its schema has no calls (`runner.ts:1006`) | gated; a refusal is `profile_violation` | unchanged |

Build changes:

- `profile.ts:10`, `:25`: `pageRead: true` in `RelayAnswerProfile`, so the
  answer record shows it (`runner.ts:1150`).
- `runner.ts:915`: create the loop when `!owner && request.delivery !== "guest"
  && (callableTools(request).length || profile.pageRead)`. Requests without
  service tools now take the round framing and schema (`runner.ts:958`,
  `:1006`). That is the one behaviour change for ordinary answers.
- `toolLoop.ts`: `read_page` joins `tools`, so the schema enum lists it
  (`protocol.ts:330`). The name is reserved: a service tool with that name is
  withheld for the request. In `runCalls` the call keeps every admission
  check: 4 per round (`:258`, `:265`), the 16-call cap (`:90`), argument
  parsing and the 64 KiB body (`:268-279`), dedupe by `call_id` (`:284-305`)
  and the output budget (`:319-328`). It then runs the reader in place of
  `send` (`:297`) and never reaches the service. Arguments are exactly
  `{ url }`. Rows record `local: true` (`:350-354`).
- `prompt.ts:58-60`: one trusted sentence in the actions text says what
  `read_page` reads. It is appended after the action-tool rewrites
  (`:61-75`), so they cannot drop it.
- `progress.ts:18-30`, `ephemeral.ts:56-68`, `:409`: emit and collect provider
  opens into `EphemeralAgentResult.providerOpens`. `cloud.ts:83-91`,
  `:152-170`: the same for Cloud.
- `runner.ts:1217-1232`: the provider-open gate before `checkedRoundV2`.
- `docs/design/relay.md` §B.6.1 and §B.6.5: record `read_page` and the gate.

## Refusal shape

A refusal is a `<tool_results>` row. `ToolProjection` (`toolLoop.ts:39-45`)
gains `refusal`:

```json
{"round":1,"tool":"read_page","arguments":{"url":"https://example.org/a"},
 "status":"denied","code":"url_refused","truncated":false,
 "refusal":{"class":"private","host":"intranet.example","hop":1},
 "output":"Refused: a redirect led to a private or local-network address. This relay reads public internet pages only; choose another source."}
```

- `host` is the URL's host name or literal at that hop. The path, query and
  resolved address are never echoed, because a split-horizon answer would
  reveal internal topology. `hop` is 0 for the requested URL. A provider open
  is a row with `"tool":"web_search"` and `"provider":true` in `refusal`.
- One sentence per class: `scheme` (only http and https pages are read);
  `credentials` (addresses with a user name or password are not read); `port`
  (only ports 80 and 443 are read); `installation_host`, `installation_address`
  (the address belongs to the installation running this assistant);
  `loopback`, `unspecified` (the address points at this machine);
  `link_local`, `private`, `unique_local` (a private or local-network address);
  `reserved` (a reserved address outside the public internet);
  `unverifiable_open` (the search tool opened a page whose address could not
  be checked; read it with `read_page`).
- Errors use `"status":"error"` with `code` from `invalid_url`, `unreachable`,
  `timeout`, `tls`, `http_status`, `unsupported_content` or
  `too_many_redirects`. A success is `"status":"ok"` with `output` holding
  `{"url": <final URL>, "title", "text"}`.
- The answer record's tool rows carry `status: "denied"`, `code: <class>` and
  `local: true` (`answers.ts:30-35`), so the operator can audit refusals.

## Entries and the check that holds each

| Entry | Check |
|---|---|
| The requested URL | checks 1-7, then a dial to the checked IP |
| Redirect hops | the same, on each hop |
| DNS change between check and connect | none possible: the dial uses the checked literal |
| Proxy variables | ignored by `node:http` with `agent: false` (observed for `HTTP_PROXY`; test k pins both) |
| Subresources, frames, scripts, sockets, workers | none fetched |
| Copied installation links | `installation_host` |
| Installation ports | the default-port rule |
| Provider opens | the round-end gate |
| Claude `WebFetch` | not offered; the init tripwire (`progress.ts:46-58`) |
| Codex `exec` isolate | no network (`relay.md` §B.6.2, E3) |

## Test plan

Every test isolates HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, and
binds port 0 on 127.0.0.1. Each reader test injects the resolver and maps
every dialled address to a recording canary server, so a policy bypass would
show as a canary hit. No default test touches the real network.

- `pageUrlPolicy.test.ts`: one row per class, including `2130706433`, `0x7f.1`,
  `[::1]`, `[::ffff:127.0.0.1]`, `0.0.0.0`, `169.254.169.254`, 100.64/10,
  fd7a::/48, NAT64, 6to4, a trailing-dot installation name and an injected
  interface address. DNS cases: all public answers pass; mixed public and
  private answers are refused; a loopback answer is refused; no answer is
  `unreachable`; a slow resolver is `timeout`. A non-default port refuses
  with zero resolver calls.
- `pageReader.test.ts`:
  (a) allowed http page: text and title returned; the canary sees `Host`, the
  User-Agent and no cookie or authorization header;
  (b) allowed https page with a test-time openssl certificate (the pattern in
  `src/lib/links/self.test.ts:338-345`); a mismatched name is `tls`;
  (c) **a host name resolving to 127.0.0.1** is refused as `loopback`, with
  zero canary hits;
  (d) **a 302 to an `http:` URL whose host is a literal in 10/8** is refused
  as `private` at hop 1, with zero hits on that canary;
  (e) a redirect to a name that resolves to 169.254.169.254 is `link_local`;
  (f) redirects to `file:` and `gopher:` are `scheme`, to the installation
  name `installation_host`;
  (g) relative redirects are followed; 6 hops give `too_many_redirects`;
  (h) a 3 MiB body and a gzip bomb stop at 2 MiB;
  (i) `image/png` is `unsupported_content`, 404 is `http_status`;
  (j) a server that never answers is `timeout` within the bound;
  (k) with `HTTP_PROXY` and `HTTPS_PROXY` set to a recording server, that
  server sees zero requests.
- `toolLoop.test.ts`: `read_page` runs locally with zero service calls; it
  shares the 4-per-round limit, the 16-call cap and the 64 KiB budget; an
  identical URL is read once; extra arguments are `invalid_arguments`.
- `progress.test.ts`: provider opens are extracted from `open_page`,
  `find_in_page`, `other` with result URLs, and `other` without them; a
  `search` item extracts nothing; notes stop after a round's first open; a
  Claude init that lists `WebFetch` is still a violation.
- `cloud.test.ts`: `webSearch` `openPage` items reach the result through the
  transport fixture.
- `runner.test.ts`, through the existing engine stubs (`runner.test.ts:246-249`)
  and an injected `cloudTransport`, once per engine path: Claude, Codex and
  Cloud each call `read_page`, the next round's prompt holds the page text, and
  the reply posts. A Codex stub that opens `http://127.0.0.1:<port>/` gets its
  round discarded, round 2 receives the refusal, and the reply never contains
  round-1 text. The same open in a chain conversation ends `profile_violation`
  and marks the conversation broken. A guest request offers no `read_page`.
- Opt-in only: one case in `src/lib/agent/ephemeral.probe.test.ts`, skipped
  unless `LLV_ANSWER_PROFILE_PROBE=1` (`:18`), records the `codex exec` item
  shape of a provider open on a subscription account. The build runs it once
  if such an account is free and reports the gap otherwise; the gate's
  field-tolerant parsing does not depend on it.

## What stays disabled

- Claude `WebFetch` and every Claude tool beyond `StructuredOutput` and
  `WebSearch`; `--settings` hooks; MCP servers.
- Every Codex feature `ephemeral.ts:254-305` and `cloud.ts:109-113` disable.
  `web_search` stays `live` with no `allowed_domains`.
- In the reader: other methods, request bodies, cookies, credentials,
  non-default ports, proxies, script execution, a browser, PDF or binary
  parsing, attachments and caching.
- Owner tier, prototype answers and guest delivery get no reader.
- No setting, switch, UI or new provider permission.

## Deferred — not currently justified

- A `relay:page_read` switch (`switches.ts:5-16`), when the operator asks to
  turn reading off.
- The reader for guest delivery.
- PDF and other non-text types.
- Linked peer installations' addresses in the name list.
- The router's public address behind NAT (hairpin to ports 80 and 443). The
  Viewer refuses a foreign `Host` (`sameOrigin.ts:55-63`); another service
  forwarded on those ports remains a residual risk.

## Acceptance mapping

| Criterion | Where |
|---|---|
| 1. Reader, policy, routing incl. provider opens | The reader; The URL policy; Provider opens; Routing per engine |
| 2. Refused classes, schemes, installation hosts and ports, redirects and DNS after resolution | Checks 1-7, address classes, installation names and ports, per-hop redirects, dial by checked IP |
| 3. Public pages read per engine; clear reasons | `read_page` on all three paths; refusal shape; runner tests |
| 4. Boundaries kept | Native tool lists and tripwires unchanged; What stays disabled |
| 5. Tests incl. redirect to private and name → loopback, no real network | Test plan (c), (d); injected resolver and canaries |
| 6. Pre-push with zero new failures | Build and publication stages |

## Evidence (2026-11-16)

- `git show --stat 6bf8b958de`: #3632 touched `conversations.test.ts`,
  `ownerRun.ts`, `prompt.test.ts`, `prompt.ts` and the new `searchGuidance.ts`.
- Bun 1.4.0 probe in a scratch directory: `fetch` sent an IP-literal request
  through `HTTP_PROXY`, and `http.request` with `agent: false` went direct;
  `HTMLRewriter` exists; `net.BlockList` matched a `::ffff:`-mapped 10/8
  address against an IPv4 /8 rule; `URL` folded `2130706433` and `0x7f.1` to
  `127.0.0.1` and kept a trailing dot.
- Rollout count, read-only, over the year's Codex session files with web
  search items: 408 files, 302 searches and 921 opens. 915 opens carry URLs and
  6 carry none. Checks 2-6, run with the two installation names known on this
  machine, refused none of the 2,600 URLs.
- The predecessor build of 2026-11-03 found no Codex control that denies
  hosts for provider opens. The pinned protocol schema confirms that only
  `allowed_domains` exists.
