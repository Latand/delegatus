# README capture checks

The required `runtime-gate` checks the README seed and all eight frame layouts
on every pull request, after the existing Viewer production build. The check
uses `scripts/capture-readme-media.ts --check-layout`, including its real seed,
page navigation, frame preparation, viewports and crops. Each shot declares its
defining subjects; their boxes must fit within the viewport, crop and every
clipping ancestor (with one CSS pixel allowed for rounding). The orchestrator
subjects include the complete decision card and its Answer button.

`--check-layout` writes PNGs and geometry into its fresh capture directory under
`TMPDIR`. Publication text/privacy checks, vector printing, OCR and media
provenance updates run in the full capture mode.
`--seed-only` runs the same complete seed without needing a build or browser.
The capture environment pins the Viewer control URL to a closed loopback port.
The seeding process keeps the whole capture root within its temp exemption;
this also works when a stage's scratch directory is inside installation state,
without granting the seed a live-state owner token.

## Local verification

Work in a scratch export. Set private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`, and set `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Supply
`CHROME_BIN` for the installed Chromium executable. When the scratch path is
too long for Chromium's Unix socket, `LLV_CHROME_TMPDIR` can name a short alias
to a directory owned by the same run.

```sh
bash scripts/gate-slot.sh bun run build
bash scripts/gate-slot.sh bun test scripts/capture-readme-media.test.ts
bash scripts/gate-slot.sh bun test scripts/bun-runtime-workflow.test.ts
bash scripts/gate-slot.sh bun scripts/capture-readme-media.ts --check-layout
bash scripts/gate-slot.sh bunx tsc --noEmit
```

Without `CHROME_BIN`, the capture test still runs the complete seed in a fresh
child process with private roots and a fixed seed timestamp. With Chromium it
also exercises geometry controls: a whole subject, each clipped viewport edge,
a clipped crop, a clipping ancestor, a missing subject and an empty subject list.
CI installs Chromium and runs both parts. The workflow test verifies that the
check follows the build, has all isolation variables and runs on every PR.

## Regression evidence

The detector was first transplanted to `7b3d575c`, before the release fix in
`9e77bba6` (#3102). Its seed test fails with
`FileTransactionBusyError: bridge report log is busy` from the first
`appendBridgeReports`. The same test completes with the release seed.

For the independent layout reproduction, the old revision retains its
1040-pixel orchestrator viewport and receives only the release seed's bridge
channel warm-up, allowing the browser to reach the form. The detector fails on
the open decision card: its bottom is at y=918.7 while
its clipping ancestor and the frame end at y=839. The failed PNG confirms that
the Answer row is clipped. That run took 11.27 seconds. The release viewport
is 1200 pixels.

## Cost and CI placement

On the production build from `9e77bba6`, with this detector, Bun 1.4.0,
Chromium 156.0.8078.4, one private seeded home and the gate's 300% CPU quota:

| Command inside the admitted gate | Result | Elapsed |
| --- | --- | ---: |
| `bun test scripts/capture-readme-media.test.ts scripts/bun-runtime-workflow.test.ts` | 26 pass | 27.05 s |
| `bun scripts/capture-readme-media.ts --check-layout` | All eight frames pass | 58.57 s |

These added checks take 85.62 seconds with an existing build and installed
Chromium. The test duration is Bun's elapsed report; the driver was measured
with `/usr/bin/time` inside the admitted gate. Browser download/system-package
provisioning and the existing
production build are outside that measurement. CI installs Chromium and reuses
its required runtime job's build. Running on every PR keeps transitive store,
style and rendered-surface changes covered without a brittle path filter.
All eight final PNGs and the clipped baseline PNG were inspected directly.
