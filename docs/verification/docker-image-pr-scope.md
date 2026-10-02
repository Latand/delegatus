# Docker PR scope and runner capacity

Baseline: `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9` (current main when work began).

## Cause, confirmed from GitHub run data

The merged #2450 workflow includes `"**/*"`. Its published PR description
describes an earlier, narrower filter. The final filter intentionally includes
every path because Tailwind's automatic discovery scanned the entire checkout,
including Markdown, YAML and shell files. Removing the glob alone would leave
real CSS inputs uncovered.

At 16:50 UTC on 2026-10-02 these five Docker jobs were inside their image-build
step. `gh api repos/{owner}/{repo}/actions/runs/{id}/jobs` supplies the intervals:

| Run | PR | Job start UTC | Job end UTC | Real input example |
| --- | --- | --- | --- | --- |
| [37036465968](https://github.com/Latand/delegatus/actions/runs/37036465968) | #2474 | 16:49:18 | 16:56:16 | `bin/cli.mjs` |
| [37034216233](https://github.com/Latand/delegatus/actions/runs/37034216233) | #2470 | 16:36:05 | 16:56:39 | `src/lib/pipelines/engine.ts` |
| [37034087384](https://github.com/Latand/delegatus/actions/runs/37034087384) | #2419 | 16:32:47 | 16:55:52 | `src/app/api/tasks/[id]/route.ts` |
| [37034008895](https://github.com/Latand/delegatus/actions/runs/37034008895) | #2458 | 16:33:09 | 16:56:09 | `src/app/api/pipelines/preflight/route.ts` |
| [37033436562](https://github.com/Latand/delegatus/actions/runs/37033436562) | #2473 | 16:35:02 | 16:56:49 | `scripts/audit-with-retry.test.ts` |

All five heads contain the broad glob and all five change real image inputs.
For #2474, [privacy-publication](https://github.com/Latand/delegatus/actions/runs/37036466214)
waited 1,309 seconds from run creation to job start; [privacy-tracker-audit](https://github.com/Latand/delegatus/actions/runs/37036466150)
waited 1,494 seconds. The existing per-ref concurrency could cancel an older
push of the same PR, but these five PR refs had independent groups.
The input changes justify their builds without counting merges from main.
Full sanitized intervals are in `evidence/docker-image/incident.json`.
The cancellations shown there predate this investigation; no runs were cancelled
or rerun during this work.

## Admission and capacity

Tailwind now starts discovery at `src/`, relative to `src/app/globals.css`.
Repository prose, hooks and unrelated workflow files no longer affect app CSS.
Docker's copied directories, manifests, patches, runtime scripts and Next's
repository-wide TypeScript and imported JS/JSON inputs remain covered.
JS/JSON outside the copied directories is listed explicitly; a regression
compares admission with the installed TypeScript program's dependency graph.
Unused evidence JSON and documentation JS/JSON skip the build. Root `.env`,
`.env.local`, `.env.production` and `.env.production.local` are inputs because
Next loads them during the production build.
Root Babel and Browserslist configuration files are also admitted and exercised
through the installed Next configuration loaders.
PostCSS rc overrides and `Dockerfile.dockerignore`, which takes precedence over
the root Docker ignore file, also trigger a build.

The broad trigger is retained for compatibility with #2452 and to avoid GitHub's
300-file trigger-filter limit. A three-minute, read-only `scope` job evaluates
the full `base...head` diff with Git. It uses immutable event SHAs, NUL-separated
paths and disabled rename detection. Main-only changes do not count; deletions
and both sides of a rename do. A Git failure fails the scope job. A successful
`build=false` skips the entire Docker job, including QEMU and Buildx setup.
Pushes to main and version tags still build and publish both architectures.

One shared job-level `docker-image-build` concurrency group admits at most one
image build across all refs. `queue: max` retains up to 100 waiting jobs without
occupying runners; a full queue cancels additional jobs according to GitHub's
documented limit. Existing workflow-level per-ref cancellation still removes
superseded branch/PR pushes; tags retain their existing protection. Release jobs
share the queue and can wait behind a PR build. The PR timeout is 45 minutes and
release timeout remains 360 minutes, matching #2452's updated approach.
Thus Docker builds cannot consume all five observed runner slots. Short scope
jobs and unrelated workflows still use runners; the capacity bound applies to Docker builds. Other workflows determine
additional queue time.

References: [GitHub concurrency and queue semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[Tailwind source roots](https://tailwindcss.com/docs/detecting-classes-in-source-files#setting-your-base-path).

## Dry evaluation and local proof

`evidence/docker-image/pr-runs.json` records the latest 30 Docker pull-request
runs returned by `gh run list --workflow docker-image.yml --event pull_request
--limit 30` at the capture time in that file. Each row uses the immutable run
`head_sha` and its merge-base against the pinned main. The run API's nested
`pull_requests[].head.sha` can advance with the PR and is deliberately unused.
The files were read with `git diff --name-only --no-renames <merge-base> <head>`.

Result: **30 build, 0 skip**. These were code PRs; the new filter continues to
validate them. The shared queue bounds image builds to one running job across
their different refs. This is a dry evaluation. Hosted execution of the new workflow remains
unverified. Re-evaluate the saved diffs with:

```sh
node - <<'JS'
const { isImageInput } = require('./scripts/docker-image-scope.cjs');
const { runs } = require('./evidence/docker-image/pr-runs.json');
for (const run of runs) {
  const build = run.files.some(isImageInput);
  if (build !== run.build) throw new Error(`Changed verdict for run ${run.runId}`);
}
console.log(`${runs.length} run verdicts reproduced`);
JS
```

`bun test scripts/docker-image-scope.test.ts` exercises both admission outcomes,
actual Git history before/after a main merge, deletion via a rename, more than
300 changed files, newline-containing paths and fatal Git errors. It also runs
the real installed Tailwind/PostCSS compiler: a utility in `src/` is emitted;
adding a unique utility to README leaves CSS byte-identical. The baseline
directive emits that README utility, proving the regression's red path.
The Git fixture also evaluates individual unused JS/JSON, imported data and
each production environment file. A separate installed Next loader probe proves
that all four admitted environment files are consumed. These regressions fail
against the pre-fix filter for unused evidence JSON and production environment
files, then pass with the explicit dependency and environment inputs.

The current actionlint v1.7.12 schema rejects the newer `concurrency.queue` key.
Its remaining checks pass with only that exact schema diagnostic ignored;
GitHub's official syntax and the workflow contract test validate `queue: max`.

## Other lane

Read #2452 and lane `2f67b71b` at `0d6874678`: retained its broad-trigger
contract, per-ref cancellation, 45/360-minute budgets and release steps.
Its other workflows, local hooks and test files are untouched. Its Docker
workflow contract remains satisfied by this change. This PR adds admission and
capacity control to that approach; it does not move further checks off CI.
