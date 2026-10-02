# Viewer hydration on load

The production build of main at `22534207a805770880cd8020e51ca106155ccf95`
produces zero hydration warnings and page errors across 40 loads: fresh
navigation and hard reload, 1440 × 900 and 390 × 844, English and Ukrainian,
clean Overview, saved project, `#p=`, transcript `#f=` and canonical `#c=`.
Each scenario uses a fresh browser context and a synthetic server home/state.
The browser reports the restored project and focused conversation through the
real presence endpoint. The record is [main.json](main.json).

The historical mismatching component was `Viewer`: its browser initializer
restored a project while the server rendered Overview. Current main already
contains the mount gate introduced in `c952b71b2`: both server and hydration
render `BootShell`; `ViewerApp` mounts after hydration and then reads browser
state. `1e3277310` also keeps the boot script's changes on the shell root, with
deterministic child markup. No currently mismatching component was found.
The older initializer/Overview handoff diagnosis has been superseded by this
boot-shell design. Product rendering code therefore needed no further change.

The regression now hydrates the real `Viewer`, checks recoverable errors and
console warnings/errors, and verifies saved/hash restoration, presence context
and unchanged saved selection on hash restore. It covers desktop and phone
with a Ukrainian browser preference. Existing shell tests separately exercise
the pre-paint boot script. The touched DOM suite's old phone assertion now
checks that the rail is absent; translated error copy can contain the product
name without drawing the rail.

The browser gate has a deliberate negative control: mutate an English
`BootShell` label in the production HTML response before React hydrates.
The gate exits 1 on a real hydration error. [negative-control.json](negative-control.json)
records this expected rejection. Its errors are intentional test inputs.

Reproduce with the existing driver (all heavy commands use the shared gate):

```sh
LLV_STATE_DIR="$(mktemp -d /var/tmp/llv-hydration-state-XXXXXX)" /var/tmp/llv-gate bun run build
TMPDIR=/var/tmp BOARD_CAPTURE_CASE=hydration /var/tmp/llv-gate bun scripts/capture-board-geometry.ts
# Expected exit 1, proving the gate rejects a hydration warning:
TMPDIR=/var/tmp BOARD_CAPTURE_CASE=hydration HYDRATION_MUTATE_SHELL=1 /var/tmp/llv-gate bun scripts/capture-board-geometry.ts
```

The driver allocates its own isolated state, provider homes and browser profiles,
reserves an ephemeral port, and closes each context, browser and owned server
in `finally`. It registers the synthetic transcript before boot so `#c=` tests
a durable conversation identity. Scanner-only files have no canonical id.

Validation: production build passed; 19 DOM tests passed; TypeScript passed;
changed-file ESLint passed with two existing unused-variable warnings in the
capture driver; privacy publication gate with commit checking passed.
This evidence exercises the local production build. No deployment was performed.
