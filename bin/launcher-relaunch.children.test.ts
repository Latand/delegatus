import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownFixtureTree, stopFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

test.if(process.platform === "linux")("launcher images reap deadline guards inherited across repeated exec", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-reap-"));
  const entry = path.join(root, "image.mjs");
  const cli = new URL("./cli.mjs", import.meta.url).href;
  const guard = new URL("./launcher-rollback-guard.mjs", import.meta.url).pathname;
  const supervisor = new URL("./self-update-supervisor.mjs", import.meta.url).href;
  fs.writeFileSync(entry, `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    import { readStartIdentity } from ${JSON.stringify(supervisor)};
    const root = ${JSON.stringify(root)}, entry = ${JSON.stringify(entry)};
    const round = Number(process.env.FIXTURE_ROUND || 0);
    // Exercise the real CLI's early imports while keeping this image alive
    // long enough to inspect its children after the inherited guard exits.
    process.argv = [process.execPath, ${JSON.stringify(new URL("./cli.mjs", import.meta.url).pathname)}, "--version"];
    await import(${JSON.stringify(cli)});
    fs.rmSync(root + "/trial.json", { force: true });
    const previous = Number(process.env.FIXTURE_GUARD);
    if (previous) {
      const until = performance.now() + 3000;
      while (fs.existsSync("/proc/" + previous) && performance.now() < until) await Bun.sleep(10);
      if (fs.existsSync("/proc/" + previous)) throw new Error("inherited guard was not reaped at round " + round);
    }
    let peer = Number(process.env.FIXTURE_PEER);
    if (!peer) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      peer = child.pid; child.unref();
      fs.writeFileSync(root + "/peer.json", JSON.stringify({ pid: peer, startIdentity: readStartIdentity(peer) }));
    }
    if (round === 6) {
      if (!fs.existsSync("/proc/" + peer)) throw new Error("live inherited child was stopped");
      // A new native handle still owns its status; the inherited-child waiter
      // must never consume its exit notification.
      const current = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
      const code = await new Promise(resolve => current.once("exit", resolve));
      if (code !== 7) throw new Error("new child status was lost");
      const owned = JSON.parse(fs.readFileSync(root + "/peer.json", "utf8"));
      if (!owned.startIdentity || readStartIdentity(peer) !== owned.startIdentity) throw new Error("inherited peer identity changed");
      process.kill(peer, "SIGTERM");
      const until = performance.now() + 3000;
      while (fs.existsSync("/proc/" + peer) && performance.now() < until) await Bun.sleep(10);
      if (fs.existsSync("/proc/" + peer)) throw new Error("inherited peer was not reaped");
      console.log("reaped six guards");
      for await (const chunk of process.stdin) {}
    } else {
      const trial = { requestId: "fixture-request", target: "a".repeat(40), state: "starting" };
      fs.writeFileSync(root + "/trial.json", JSON.stringify(trial));
      const plan = { ...trial, paths: { trial: root + "/trial.json", record: root + "/record.json" },
        pid: process.pid, identity: readStartIdentity(process.pid), deadline: Date.now() + 60000 };
      const child = spawn(process.execPath, [${JSON.stringify(guard)}, Buffer.from(JSON.stringify(plan)).toString("base64")],
        { detached: true, stdio: ["ignore", "pipe", "inherit"] });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", resolve);
      });
      child.stdout.destroy(); child.unref();
      process.execve(process.execPath, [process.execPath, entry], { ...process.env,
        FIXTURE_ROUND: String(round + 1), FIXTURE_GUARD: String(child.pid), FIXTURE_PEER: String(peer) });
    }
  `);
  const child = ownFixtureTree(spawn(process.execPath, [entry], {
    cwd: process.cwd(), env: { ...process.env, LLV_LAUNCHER_REEXEC: "1", FIXTURE_ROUND: "0", FIXTURE_GUARD: "", FIXTURE_PEER: "" }, stdio: ["pipe", "pipe", "pipe"],
  }));
  let output = "", error = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { error += chunk; });
  try {
    const deadline = performance.now() + 15000;
    while (!output.includes("reaped six guards") && child.exitCode === null && performance.now() < deadline) await Bun.sleep(10);
    expect({ output: output.includes("reaped six guards"), error, exit: child.exitCode })
      .toEqual({ output: true, error: "", exit: null });
    const pids = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
    expect(pids).toBe("");
  } finally {
    child.stdin!.end();
    await stopFixtureProcess(child);
    if (fs.existsSync(path.join(root, "peer.json"))) {
      await stopFixtureIdentity(JSON.parse(fs.readFileSync(path.join(root, "peer.json"), "utf8")));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

for (const mode of ["invalid-ready", "readiness-timeout", "early-exit", "exec-error"]) {
  test.if(process.platform === "linux")(`launcher reaps its deadline guard after ${mode}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-guard-"));
    const bin = path.join(root, "bin"), entry = path.join(root, "owner.mjs");
    fs.mkdirSync(bin);
    for (const name of fs.readdirSync(import.meta.dir).filter(name => name.endsWith(".mjs"))) {
      fs.copyFileSync(path.join(import.meta.dir, name), path.join(bin, name));
    }
    fs.writeFileSync(path.join(bin, "launcher-rollback-guard.mjs"), `
      import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(path.join(root, "guard-pid"))}, String(process.pid));
      if (${JSON.stringify(mode)} === "early-exit") process.exit(7);
      if (${JSON.stringify(mode)} === "exec-error") console.log("ready");
      if (${JSON.stringify(mode)} === "invalid-ready") console.log("invalid");
      const owner = process.ppid;
      setInterval(() => { if (process.ppid !== owner) process.exit(0); }, 100);
    `);
    fs.writeFileSync(entry, `
      import fs from "node:fs";
      import { createRelaunch } from "./bin/launcher-relaunch.mjs";
      const root = ${JSON.stringify(root)};
      const paths = { trial: root + "/trial.json", record: root + "/record.json",
        request: root + "/request.json", releasePointer: root + "/release.json" };
      fs.writeFileSync(paths.trial, JSON.stringify({ requestId: "fixture-request", target: "b".repeat(40),
        previousEntry: root + "/previous.mjs", rollbackPointer: null, state: "starting" }));
      process.env.LLV_LAUNCHER_TRIAL = "fixture-request";
      const relaunch = createRelaunch({ paths, installRoot: root, entry: root + "/owner.mjs",
        release: { sha: "b".repeat(40) }, stop: async () => {}, record: { set() {} }, args: [] });
      process.execve = () => { throw new Error("induced exec failure"); };
      const exit = process.exit;
      process.exit = () => { throw new Error("induced refusal"); };
      try { await relaunch.failed("induced startup failure"); } catch {}
      finally { process.exit = exit; }
      const pid = Number(fs.readFileSync(root + "/guard-pid", "utf8"));
      console.log(JSON.stringify({ unreaped: fs.existsSync("/proc/" + pid) }));
    `);
    const child = ownFixtureTree(spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "pipe"] }));
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
    let output = "", error = "";
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { error += chunk; });
    try {
      await closed;
      expect({ exit: child.exitCode, output: output.trim() }).toEqual({ exit: 0, output: '{"unreaped":false}' });
      expect(error).toContain("launcher startup refused");
    } finally {
      clearTimeout(watchdog);
      await stopFixtureProcess(child);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}
