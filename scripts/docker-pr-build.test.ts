import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dir, "docker-pr-build.sh");

function run(buildStatus: number | "hang", cleanupStatus = 0, platforms = "linux/amd64") {
  const cwd = mkdtempSync(path.join(tmpdir(), "docker-pr-deadline-"));
  const log = path.join(cwd, "calls");
  const pidFile = path.join(cwd, "pid");
  try {
    // Only this stub's build process is started. GNU timeout owns its process
    // group; the cleanup command records the exact builder the job created.
    writeFileSync(path.join(cwd, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$2" == build ]]; then
  echo $$ > "$PID_FILE"
  if [[ "$BUILD_STATUS" == hang ]]; then
    trap '' TERM
    while :; do :; done
  fi
  exit "$BUILD_STATUS"
fi
exit "$CLEANUP_STATUS"
`, { mode: 0o755 });
    const started = performance.now();
    const result = spawnSync("bash", [script, "job-owned-builder", platforms], {
      cwd, encoding: "utf8", timeout: 5_000,
      env: { ...process.env, PATH: `${cwd}:${process.env.PATH}`, CALL_LOG: log, PID_FILE: pidFile,
        BUILD_STATUS: String(buildStatus), CLEANUP_STATUS: String(cleanupStatus),
        DOCKER_PR_BUILD_TIMEOUT: "0.2s", DOCKER_PR_KILL_AFTER: "0.2s" },
    });
    const elapsed = performance.now() - started;
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return { result, elapsed, calls, pid };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("successful PR verification builds the published target without push and removes its builder", () => {
  for (const platforms of ["linux/amd64", "linux/amd64,linux/arm64"]) {
    const { result, calls } = run(0, 0, platforms);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      `buildx build --builder job-owned-builder --progress plain --file Dockerfile --target published --platform ${platforms} --output type=cacheonly .`,
      "buildx rm --force job-owned-builder",
    ]);
  }
});

test("a build that ignores TERM is killed within the deadline and its daemon is removed", () => {
  const { result, elapsed, calls, pid } = run("hang");
  expect(result.status, result.stderr).toBe(137);
  expect(elapsed).toBeLessThan(3_000);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(calls.at(-1)).toBe("buildx rm --force job-owned-builder");
});

test("build failures survive cleanup, and cleanup failures fail successful builds", () => {
  for (const [buildStatus, cleanupStatus, expected] of [[17, 0, 17], [17, 19, 17], [0, 19, 1]]) {
    const { result, calls } = run(buildStatus, cleanupStatus);
    expect(result.status, result.stderr).toBe(expected);
    expect(calls.at(-1)).toBe("buildx rm --force job-owned-builder");
  }
});
