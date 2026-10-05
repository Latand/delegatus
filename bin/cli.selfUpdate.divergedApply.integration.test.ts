import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { git, install, pointerFile, readRecord, registerSelfUpdateCleanup, release, served, socketAnswers, start, until } from "./__fixtures__/cli-self-update";

/*
 * An apply on an install whose processes do not serve what its pointer names,
 * through the real `bin/cli.mjs`. The pointer here was published for another
 * checkout HEAD, so every start ignores it and serves the checkout: the state
 * a checkout reaches when its HEAD moves past the release it last built.
 * Every child here is one the test or the CLI started.
 */

registerSelfUpdateCleanup();

async function divergedInstall() {
  const fixture = install();
  const stale = release(fixture, "stale-pointer");
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  const pointer = JSON.stringify({ sha: stale.sha, dir: stale.dir, checkoutHead: "f".repeat(40) });
  writeFileSync(pointerFile(fixture), pointer);
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  // The checkout serves; the pointer names a release nobody runs.
  expect(await served(running.port)).toBe(fixture.checkout);
  expect(before.web.revision).toBe(fixture.first.slice(0, 7));
  expect(before.launcher.revision).toBe(fixture.first);
  expect(JSON.parse(pointer).sha.slice(0, 7)).not.toBe(before.web.revision);
  return { fixture, running, before, pointer, directory: path.dirname(before.requestFile) };
}

test("a replacement that fails its load check settles failed and releases the hold on a diverged install", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { activeDrain } = await import("../src/lib/selfUpdate/drain");
  const { fixture, running, before, pointer, directory } = await divergedInstall();
  const candidate = release(fixture, "cannot-load", { launcher: 'throw new Error("fixture import failure");\n' });
  const apply = new ApplyController(directory);
  apply.begin(before as never, candidate.sha, "operator");
  expect(apply.current).toMatchObject({ rollbackPointer: pointer, rollbackLauncherRevision: fixture.first, rollbackWebRevision: fixture.first.slice(0, 7) });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.patch({ state: "ready" }); apply.send(before as never);
  const hold = path.join(directory, "auto-drain.json");
  expect(activeDrain(hold)).not.toBeNull();
  const settled = await until(() => { const r = readRecord(fixture.state); return r.launcher.requestId === apply.current!.requestId && r.launcher.error?.kind === "fell-back" ? r : null; }, 60_000);
  // Nothing was stopped, and the launcher put the exact pointer back.
  expect(settled.launcher.pid).toBe(before.launcher.pid);
  expect(settled.web.pid).toBe(before.web.pid); expect(settled.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(readFileSync(before.releasePointer, "utf8")).toBe(pointer);
  const viewer = new ApplyController(directory);
  expect(viewer.observe(settled as never, await socketAnswers(settled.socket))).toBe("failed");
  expect(viewer.current).toMatchObject({ state: "failed", rolledBack: true });
  expect(activeDrain(hold)).toBeNull();
  expect(await served(running.port)).toBe(fixture.checkout);
  // The next update is admitted.
  expect(() => new ApplyController(directory).begin(settled as never, candidate.sha, "operator")).not.toThrow();
}, 90_000);

test.each(["building", "ready", "published"] as const)("a launcher restarted during an update on a diverged install starts and fails the apply: %s", async state => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { activeDrain, writeDrain } = await import("../src/lib/selfUpdate/drain");
  const { fixture, running, before, pointer, directory } = await divergedInstall();
  const candidate = release(fixture, "interrupted-build");
  const apply = new ApplyController(directory);
  apply.begin(before as never, candidate.sha, "operator");
  if (state !== "building") apply.patch({ state: "ready" });
  // The build finished and selected the candidate: the next start is the candidate's own launcher.
  if (state === "published") writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  const hold = path.join(directory, "auto-drain.json");
  writeDrain(hold, { id: apply.current!.requestId, target: candidate.sha, since: apply.current!.startedAt, until: Date.now() + 600_000, persistent: true });
  const exited = new Promise<void>(resolve => running.child.once("exit", () => resolve()));
  running.child.kill("SIGTERM"); await exited;
  const again = await start(fixture);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && (!r.launcher.state || r.launcher.state === "healthy")
    && r.web.state === "healthy" && r.runtimeHost.state === "healthy" && r.web.revision === fixture.first.slice(0, 7) ? r : null; }, 60_000);
  expect(again.child.exitCode).toBeNull();
  expect(again.output()).not.toContain("custody is retained");
  expect(await served(again.port)).toBe(fixture.checkout);
  expect(after.runtimeHost.revision).toBe(fixture.first.slice(0, 7));
  expect(readFileSync(before.releasePointer, "utf8")).toBe(pointer);
  const viewer = new ApplyController(directory);
  if (state === "published") {
    // The candidate's launcher rolled itself back; the Viewer settles it against what the apply captured.
    expect(after.launcher).toMatchObject({ requestId: apply.current!.requestId, error: { kind: "fell-back" }, revision: fixture.first });
    expect(viewer.observe(after as never, false)).toBeNull();
    expect(activeDrain(hold)).not.toBeNull();
    expect(viewer.observe(after as never, await socketAnswers(after.socket))).toBe("failed");
    expect(viewer.current).toMatchObject({ state: "failed", rolledBack: true });
  } else {
    expect(JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"))).toMatchObject({ requestId: apply.current!.requestId, state: "failed", rolledBack: false });
    // The Viewer of the new start reads a settled apply.
    expect(viewer.observe(after as never, await socketAnswers(after.socket))).toBeNull();
  }
  expect(existsSync(before.requestFile.replace("request-", "trial-"))).toBe(false);
  expect(activeDrain(hold)).toBeNull();
  expect(() => new ApplyController(directory).begin(after as never, candidate.sha, "operator")).not.toThrow();
}, 90_000);

/* The recovery helper restarts a unit from a plan, on the proof the Viewer
   asks for (bin/launcher-service-proof.mjs). The service manager here answers
   `show` the way systemd does and refuses every restart, so a proven unit is
   seen being handed over and nothing is ever restarted. */
test("the recovery helper restarts only a unit proven to run this launcher", async () => {
  const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const fixture = install();
  const control = path.join(fixture.state, "self-update"); mkdirSync(control, { recursive: true });
  const requestFile = path.join(control, "request-fixture.json"), planFile = path.join(control, "recovery-fixture.json");
  const target = "a".repeat(40), requestId = "unit-proof";
  // After the first self-update the unit's main process is the bootstrap and
  // the recorded launcher is its child. Both processes belong to this test.
  const bootRoot = path.join(fixture.root, "bootstrapped"); mkdirSync(path.join(bootRoot, "bin"), { recursive: true });
  writeFileSync(path.join(bootRoot, "bin", "cli.mjs"), `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(child.pid); setInterval(() => {}, 1000);
`);
  const bootstrap = Bun.spawn([process.execPath, "bin/cli.mjs", "--no-open"], { cwd: bootRoot, stdout: "pipe", stderr: "ignore" });
  const reader = bootstrap.stdout.getReader(); let printed = "";
  while (!printed.includes("\n")) { const chunk = await reader.read(); if (chunk.done) break; printed += new TextDecoder().decode(chunk.value); }
  const child = Number(printed.trim());
  try {
    expect(child).toBeGreaterThan(0);
    // A plan whose custody is all in order: only the unit's proof differs.
    const custody = (launcherPid: number) => {
      writeFileSync(path.join(control, "apply.json"), JSON.stringify({ requestId, target, state: "switching", externalRestart: true, trigger: "operator",
        launcherPid, launcherIdentity: readStartIdentity(launcherPid), rollbackPointer: null, releasePointer: path.join(control, "release-fixture.json"),
        rollbackWebRevision: fixture.first.slice(0, 7), rollbackHostRevision: fixture.first.slice(0, 7), startedAt: new Date().toISOString(), rolledBack: false }));
      writeFileSync(path.join(control, "trial-fixture.json"), JSON.stringify({ requestId, target, rollbackPointer: null, previousEntry: path.join(fixture.checkout, "bin", "cli.mjs"), state: "rolled-back", detail: "fixture" }));
      writeFileSync(path.join(control, "launcher-fixture.json"), JSON.stringify({ launcher: { pid: launcherPid, startIdentity: readStartIdentity(launcherPid) } }));
    };
    const managerDir = path.join(fixture.root, "manager"); mkdirSync(managerDir);
    const asked = path.join(managerDir, "asked.log");
    const shown = (start: string, main: number, directory = "") => `MainPID=${main}\nExecStart={ path=${start.split(" ")[0]} ; argv[]=${start} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=${main} ; code=(null) ; status=0/0 }\nWorkingDirectory=${directory}`;
    const entry = path.join(fixture.checkout, "bin", "cli.mjs");
    const units: Record<string, string> = {
      // The launcher's own parent is the main process of these, as a terminal
      // is of what was typed into it.
      "tmux.service": shown("/usr/bin/tmux new-session -d -s main", process.ppid),
      "gnome-terminal-server.service": shown("/usr/libexec/gnome-terminal-server", process.ppid),
      // Written with a specifier in the unit file; the manager shows it expanded.
      "expanded.service": shown(`${process.execPath} ${entry} --no-open`, 4242, fixture.checkout),
      "relative.service": shown(`${process.execPath} --bun bin/cli.mjs --no-open`, 4242, fixture.checkout),
      "bootstrap.service": shown("/usr/local/bin/start-delegatus", bootstrap.pid),
    };
    writeFileSync(path.join(managerDir, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(asked)}
case "$*" in *" show "*) ;; *) exit 1 ;; esac
case "$*" in
${Object.entries(units).map(([unit, text]) => `  *" ${unit}") cat <<'SHOWN'\n${text}\nSHOWN\n  ;;`).join("\n")}
esac
`); chmodSync(path.join(managerDir, "systemctl"), 0o700);
    const helper = (unit: string, root: string) => {
      writeFileSync(planFile, JSON.stringify({ requestId, requestFile, unit, root, custody: false, context: { HOME: fixture.env.HOME } }));
      return spawnSync(process.execPath, ["--bun", path.resolve("bin/launcher-relaunch.mjs"), "--recover-service", planFile],
        { env: { ...fixture.env, PATH: managerDir + path.delimiter + fixture.env.PATH }, encoding: "utf8", timeout: 30_000 });
    };
    const restarts = () => readFileSync(asked, "utf8").trim().split("\n").filter(line => !line.includes(" show "));
    custody(process.pid);
    for (const unit of ["tmux.service", "gnome-terminal-server.service"]) {
      const run = helper(unit, fixture.checkout);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("not proven to run this launcher");
      expect(existsSync(planFile)).toBe(false);
    }
    expect(readFileSync(asked, "utf8").trim().split("\n")).toEqual(["tmux.service", "gnome-terminal-server.service"]
      .map(unit => `--user show --property=ExecStart --property=WorkingDirectory --property=MainPID ${unit}`));
    // The same unit does not prove another install.
    expect(helper("expanded.service", path.join(fixture.root, "elsewhere")).stderr).toContain("not proven to run this launcher");
    expect(restarts()).toEqual([]);
    for (const unit of ["expanded.service", "relative.service"]) {
      const run = helper(unit, fixture.checkout);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Service recovery was refused");
      expect(restarts().at(-1)).toBe(`--user restart ${unit}`);
    }
    // The bootstrap is the parent of the recorded launcher, and of nothing else.
    expect(helper("bootstrap.service", bootRoot).stderr).toContain("not proven to run this launcher");
    custody(child);
    expect(helper("bootstrap.service", fixture.checkout).stderr).toContain("not proven to run this launcher");
    expect(restarts()).toHaveLength(2);
    const run = helper("bootstrap.service", bootRoot);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Service recovery was refused");
    expect(restarts()).toEqual(["--user restart expanded.service", "--user restart relative.service", "--user restart bootstrap.service"]);
    expect(JSON.parse(readFileSync(path.join(control, "apply.json"), "utf8")).state).toBe("switching");
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(fixture.first);
  } finally {
    for (const pid of [child, bootstrap.pid]) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}, 60_000);
