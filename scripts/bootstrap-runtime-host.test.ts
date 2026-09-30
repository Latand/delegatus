import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseArguments } from "./bootstrap-runtime-host";

const source = fs.readFileSync(new URL("./bootstrap-runtime-host.ts", import.meta.url), "utf8");
const bootstrap = path.join(import.meta.dir, "bootstrap-runtime-host.ts");

function stopRecordedSleep(pidFile: string): void {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  if (!Number.isInteger(pid) || pid < 1) return;
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0", 1)[0];
    if (path.basename(command ?? "") === "sleep") process.kill(pid, "SIGKILL");
  } catch { /* the timeout already reaped the recorded helper child */ }
}

test("issue 1216: the bootstrap plans by default and never mutates without an explicit mode", () => {
  expect(parseArguments([])).toEqual({ revision: "origin/main", mode: "plan" });
  expect(parseArguments(["a".repeat(40)])).toEqual({ revision: "a".repeat(40), mode: "plan" });
  expect(parseArguments(["--stage"])).toEqual({ revision: "origin/main", mode: "stage" });
  expect(parseArguments(["a".repeat(40), "--hand-over"])).toEqual({ revision: "a".repeat(40), mode: "hand-over" });
});

test("issue 1216: the bootstrap refuses arguments it does not understand", () => {
  expect(() => parseArguments(["--force"])).toThrow("unsupported option --force");
  expect(() => parseArguments(["main"])).toThrow("invalid revision: use origin/main or a full lowercase commit SHA");
  expect(() => parseArguments(["a".repeat(40), "b".repeat(40)])).toThrow("only one revision may be given");
});

/* The machine this runs on owns live agent sessions, so the statement of what
   will be stopped has to precede every mutation — the image build, the
   staging, and the predecessor stop alike. */
test("issue 1216: the plan is rendered before anything is built, staged, or stopped", () => {
  const planAt = source.indexOf("console.log(renderRuntimeHostBootstrapPlan(plan))");
  const buildAt = source.indexOf("await buildRuntimeHostImage(revision, image)");
  const executeAt = source.indexOf("await executeRuntimeHostBootstrap(plan, candidate,");

  expect(planAt).toBeGreaterThanOrEqual(0);
  expect(buildAt).toBeGreaterThan(planAt);
  expect(executeAt).toBeGreaterThan(buildAt);
});

/* An operator stages now and hands over when they are ready, so the successor
   this script creates has to wait without the #518 deadline — that bound
   exists for a hand-over already in flight, and here there is none until the
   operator starts one. */
test("issue 1216: the bootstrap stages its successor parked rather than on the deployment fence budget", () => {
  expect(source).toContain('fenceWait: "parked"');
  expect(source).not.toContain("LLV_RUNTIME_HOST_FENCE_WAIT_MS");
});

/* The bootstrap replaces the runtime-host generation and nothing else. A
   Viewer container stop or removal here would take down the promoted release
   and the agent sessions inside it. */
test("issue 1216: the bootstrap never stops or removes a Viewer release container", () => {
  expect(source).not.toContain('"container", "rm"');
  expect(source).not.toContain("retireRelease");
  expect(source).not.toContain("switchTarget");
  /* The single stop it performs is the predecessor runtime-host container,
     reached only through the hand-over port. */
  expect(source.match(/"container", "stop"/g)).toHaveLength(1);
});

test("the bootstrap retries a fetch after timing out a command with a hanging child", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bootstrap-mirror-timeout-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  const sourceRepo = path.join(sandbox, "source");
  const remote = path.join(sandbox, "canonical.git");
  const mirror = path.join(state, "deployments", "canonical.git");
  const shim = path.join(bin, "git");
  const attempts = path.join(sandbox, "fetch-attempts");
  const childPidFile = path.join(sandbox, "fetch-child.pid");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(sourceRepo);
  fs.mkdirSync(remote);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    git(remote, "init", "--bare", "--initial-branch=main");
    git(sourceRepo, "init", "--initial-branch=main");
    git(sourceRepo, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "release");
    const revision = git(sourceRepo, "rev-parse", "HEAD");
    git(sourceRepo, "remote", "add", "origin", remote);
    git(sourceRepo, "push", "origin", "main");
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    git(sandbox, "clone", "--mirror", remote, mirror);
    fs.writeFileSync(shim, `#!/bin/sh
set -eu
case " $* " in
  *" fetch "*)
    if [ ! -f ${quoted(attempts)} ]; then
      echo first > ${quoted(attempts)}
      (sleep 120) &
      echo $! > ${quoted(childPidFile)}
      wait
    fi
    echo retry >> ${quoted(attempts)}
    ;;
esac
exec /usr/bin/git "$@"
`, { mode: 0o700 });

    const child = Bun.spawn(["/usr/bin/setsid", "--wait", process.execPath, bootstrap, "origin/main"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        LLV_STATE_DIR: state,
        LLV_VIEWER_CANONICAL_REMOTE: remote,
        LLV_VIEWER_PORT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 40_000); });
    const result = await Promise.race([child.exited, timeout]);
    if (result === "timeout") {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      await child.exited;
    } else if (timer) clearTimeout(timer);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();

    expect(result).not.toBe("timeout");
    expect(result).toBe(1); // The real plan reaches its expected no-live-predecessor fence.
    expect(stdout).toContain(revision);
    expect(stderr).toContain("no running runtime-host container owns the singleton fence");
    expect(fs.readFileSync(attempts, "utf8")).toBe("first\nretry\n");
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    const stateLine = fs.existsSync(`/proc/${childPid}/stat`) ? fs.readFileSync(`/proc/${childPid}/stat`, "utf8") : "";
    expect(stateLine.split(" ")[2] === "Z" || !stateLine).toBe(true);
    expect(git("/", "--git-dir", mirror, "rev-parse", "refs/heads/main")).toBe(revision);
  } finally {
    stopRecordedSleep(childPidFile);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 45_000);
