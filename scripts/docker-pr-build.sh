#!/usr/bin/env bash
# The client deadline also removes this job's BuildKit daemon, where RUN
# commands execute. Reserve the remaining job timeout for bounded cleanup.
set -euo pipefail
builder=${1:?Expected the builder created by this job}
platforms=${2:?Expected verification platforms}
case "$platforms" in
  linux/amd64|linux/amd64,linux/arm64) ;;
  *) echo 'Unsupported verification platforms' >&2; exit 2 ;;
esac

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if ! timeout --kill-after=5s 60s docker buildx rm --force "$builder"; then
    echo 'Failed to remove the PR builder within the cleanup deadline' >&2
    if [[ "$result" == 0 ]]; then result=1; fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# cacheonly verifies the published target without loading, exporting or pushing
# an image. Publication retains its shared GitHub Actions cache.
timeout --signal=TERM --kill-after="${DOCKER_PR_KILL_AFTER:-30s}" "${DOCKER_PR_BUILD_TIMEOUT:-40m}" \
  docker buildx build --builder "$builder" --progress plain \
    --file Dockerfile --target published --platform "$platforms" \
    --output type=cacheonly .
