# Stage branches

Every pull request used to run the whole CI matrix on every push: platform
tests in eight shards, Windows and macOS jobs, the pinned Bun runtime, native
Codex on eight versions and the image scope, about 25 jobs. Main is protected
with `strict`, so every merge sent the other open pull requests back through all
of it. With many lanes open, the shared runner pool queued for an hour and more.

Work now reaches main in batches. The heavy workflows run only for pull
requests into `main`; a batch collects on a `stage/*` branch first.

## The flow

1. **Open a stage** from current main. Name it after its theme or its day, for
   example `stage/perf-2026-11-12`:

   ```sh
   git push origin origin/main:refs/heads/stage/perf-2026-11-12
   ```

   Several stages can be open at once.
2. **Point work pull requests at the stage**: `gh pr create --base stage/<name>`,
   or `gh pr edit <n> --base stage/<name>` for an open one. They run only the two
   privacy checks (`privacy-publication`, `privacy-tracker-audit`), which every
   public surface needs. The local pre-push gate still runs types, lint and the
   touched tests on every push. Merge each one into the stage with a squash, so
   the stage holds one commit per pull request. `stage/*` has no branch
   protection.
3. **Ship the stage** when it holds a batch (10 to 20 pull requests) or has to
   go out: open one pull request from `stage/<name>` into `main`. That pull
   request runs the full matrix once for the whole batch, including the
   required `typecheck` and `runtime-gate`. Merge it with a merge commit, so
   main keeps one commit per landed pull request.
4. **Other open stages** are behind main after a stage merges. Update each stage
   pull request once (`gh pr update-branch <n>`), which reruns its CI once.
5. **A red stage pull request** is fixed on the stage: a fix pull request into
   the stage, or a revert of the offending squash commit there. The stage pull
   request then reruns.
6. Delete the stage branch after it merges.

Main's protection is unchanged: the same four required checks, `strict`, and
admins included. Pushes to main still run the Bun runtime and image workflows,
which the self-update gate and the published image depend on. The nightly
workflow still runs the full test suite on main.
