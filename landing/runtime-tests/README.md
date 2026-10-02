# Landing Worker runtime regression

Run from the repository root with Node 22 or newer and Bun:

```sh
bun install --cwd landing/runtime-tests --frozen-lockfile
node --test landing/runtime-tests/access.workerd.mjs
```

This separate package pins Miniflare and its workerd runtime without changing
the Viewer's dependencies. The current Miniflare prerelease supports the
Worker's configured compatibility date; the latest stable Miniflare runtime
predates it. The harness reads that date from `landing/wrangler.jsonc`,
transpiles `landing/worker.ts`, and runs its actual fetch handler in workerd.
Only outbound HTTP is stubbed. Each test generates a synthetic RSA assertion,
and all runtimes are disposed in `finally`. No real assertion is needed.

The successful path checks both stats URLs, completed-key caching, real
signature verification, and all twenty SQL calls across the two responses.
The other cases cover overlapping requests, invalid assertions, key selection,
signature tampering, rejected methods, invalid key sets, HTTP failure, and
redirects from both upstream services. The SQL redirect case checks that no
destination receives the server credential.

## Cause and reproduction evidence

At base `4c289164e53477d74198d5a606556418af0e61d1`, two local workerd
requests using the existing assertion and the configured Access vars passed
configuration, token shape, header decode, claims decode, and claims checks.
Both failed at `certs-fetch`, with a TypeError classified as redirect-related.
The temporary probe reported only fixed step names and pass/fail, and did not
write the assertion or its contents into an artifact.

Changing only that fetch's redirect mode from `error` to `manual` in a
temporary source copy made both requests pass key fetch, HTTP status, JSON,
key set shape, key selection, key import, signature verification, and final
expiry. Repeating the same probe against the fixed source passed twice.

The committed synthetic regression, run before the source fix, failed its
success assertion with `403 !== 200` and made no outbound certs request.
Overall the base run failed nine of eleven cases; the fixed run passed all
eleven. The successful stats response also exercises the SQL fetch, which
used the same rejected redirect mode.

Both fetches now use `manual`: redirects remain unfollowed and the existing
`response.ok` check rejects their HTTP status. Every JWT, key, signature,
timeout, and final expiry check stays in place. Public denial responses remain
generic because the cause is reproducible without adding a diagnostic surface.

Local runtime evidence establishes the cause and fix. Deployment and a live
browser acceptance check require a separate operator-approved step:
**deploy needs the operator's go**.
