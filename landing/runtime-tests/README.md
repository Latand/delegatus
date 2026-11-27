# Landing Worker runtime regression

Run from the repository root with Node 22 or newer and Bun:

```sh
bun install --cwd landing/runtime-tests --frozen-lockfile
node --test landing/runtime-tests/stats.workerd.mjs
```

The separate package pins Miniflare and workerd. It bundles the Wrangler
entry with esbuild and reads the compatibility date and binding from
`landing/wrangler.jsonc`. The Worker, its RPC methods and SQLite-backed
Durable Object run in workerd. Miniflare’s local storage inspector changes
session age and seeds swarm counts. The real Durable Object alarm sends the
import requests through a local Analytics Engine stub.

The tests use a virtual P-256 key to enroll and sign in, verify that the
signed-in page renders all metrics, and exercise missing, forged, expired,
revoked and replayed credentials. A fresh workerd instance reopens the
fixture SQLite database and checks that sessions and replay guards persist.
The history test verifies that HTTP redirects stay unfollowed and that only
a fixed error class reaches the stats page. Each runtime disposes in
`finally`. Fixtures contain invented counts and credentials.

The focused Bun test runs by path with `bun test landing/worker.test.ts`.
To capture the sign-in, enrollment and import states at 1280, 800 and 390 px,
run the Bun test with `STATS_RENDER_DIR` pointing at a scratch directory.
Then run the workerd test with that directory as `STATS_FIXTURE_DIR`,
`CHROME_BIN` set to Chromium, and `STATS_RENDER_DIR` pointing at the evidence
directory. Chromium uses the Worker’s response headers and virtual passkey
support for its enrollment, sign-in, restart and revocation checks.
The deployment and private production check are documented in
[the private stats rollout](../../docs/design/stats-private-login.md#5-rollout).
