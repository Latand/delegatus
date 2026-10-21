# Host allowlist

A security audit finding identified reads that could reach the Viewer with a
foreign Host when no access key was configured. The regression is demonstrated
through the request perimeter; a browser DNS-rebinding attack was not reproduced.

`src/proxy.ts` calls `rejectForeignHost` before credentials, redirects, team
admission, peer-route exemptions and signed artifact frames. Its compiled matcher
covers every App Router entry, including static assets. `/api/streams` retains
its existing matcher exclusion to bound control bodies; its GET, POST and channel
open paths call the same proxy themselves.

`src/lib/sameOrigin.ts` accepts loopback names, the launcher's configured
`HOSTNAME`, `LLV_TS_HOST`, and `LLV_PUBLIC_HOST` while the access key exists.
Wildcard binds admit only their literal addresses. Names compare without case;
ports must be syntactically valid, but remain independent of the upstream port
so stable listeners and reverse proxies keep working. The request URL, Origin,
forwarding headers, cookies and bearer credentials cannot add a Host to the list.
Write handlers retain their Origin and Sec-Fetch-Site checks. First-time public
address setup uses loopback or an explicitly configured hostname; credentials
alone no longer bootstrap an unknown Host through Settings.

An address Save checks the proposed name before committing it. Its existing
bounded nonce registry now records the proposed Host too. While the access key
exists, that name is admitted only for the pending nonce's self-check POST.
Consumption, expiry, request completion and process restart remove this
permission. The nonce permits no transcript reads, streams or other peer actions.
An unknown Host rewritten by a reverse proxy is refused before the self-check
handler; that address remains unverified. Rewrites to an already allowed name
still reach the handler and retain the existing rewrite diagnostic.

## Callers checked

| Caller | Host source and verification |
| --- | --- |
| Browser UI | Loopback and explicit launcher bind name; `src/proxy.host.test.ts`, `src/proxy.test.ts`, `src/proxy.team.test.ts` cover open/keyed requests, cookies and team admission. |
| Phone/Tailscale | `src/lib/access/phoneAccess.ts` supplies `LLV_TS_HOST`; proxy tests cover the pinned name, browser authentication and handoff links. |
| Linked installations | Saved `LLV_PUBLIC_HOST`, outbound URL authority, peer credentials and pending self-check; `src/lib/links/self.test.ts` drives real local HTTP/TLS reverse proxies through the perimeter. |
| Runtime host | Its stable gateway preserves Host; `src/proxy.team.test.ts` exercises the production tick client and health-probe plans. The intentional foreign-Host health probe still receives a recognized 403. |
| MCP HTTP clients | The control URL supplies the HTTP Host; proxy team tests exercise production reads and deployment requests with and without an access key. |
| Voice relay | `src/lib/voiceCompanion/deliveryPaths.ts` constructs a loopback Host for in-process delivery. Its existing delivery and HTTP tests cover the caller. |
| Telegram relay | `src/lib/telegram/reportSpawn.ts` constructs loopback Host and Origin for in-process spawn. `src/proxy.host.test.ts` checks those production headers through both Host and write-origin guards. |
| Landing Worker | `landing/worker.ts` is a separate entry point and imports no Viewer proxy; its own tests cover its public routes. |

## Regression procedure

Export the starting revision into stage-owned scratch, copy the new regression
tests into that export, and run `bun test src/proxy.host.test.ts` through
`scripts/gate-slot.sh`. On starting revision `3e6ca3c1`, all 24 representative
foreign-Host GET cases received 200 instead of 403: page, conversations, file
listing, artifact, both searches, three SSE routes, peer self-check, signed frame
and sign-in, each keyless and with valid credentials. The first guard alone
turned those cases green; the next tests exposed name casing, malformed Host,
static matcher coverage and pre-save linked-address probing.

Run each touched test file by its explicit path with isolated HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and a closed-port
LLV_VIEWER_CONTROL_URL. Run the typecheck and local pre-push gate too. Tests and
build output belong to scratch exports. This change claims no performance gain;
the ordinary Host check parses a header and a fixed-size set of configured names
without DNS, state-file reads or network work.

The optional `src/lib/telegram/reportSpawn.test.ts` admission suite has two
pre-existing fixture failures: its registry mock lacks
`deliveryWriteBatchOrBusy`. Both failures were reproduced on `3e6ca3c1` with the
same isolated environment. The focused production-header regression passes.
