import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { procBackend } from "../src/lib/proc";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

import {
  BUILT_SERVER_DIR,
  COMPILED_SERVER_DIR,
  REQUIRED_SERVER_RUNTIME,
  missingRequiredModules,
  servedRuntimeModules,
  verifyBuiltCodexSocket,
  sandboxEnvironment,
  verifyViewerRuntime,
  hasBuiltPipelineRoute,
  collector,
} from "./verify-viewer-runtime";
import { isOperatorOwnedDirectory, setStateOwnershipPathsForTests } from "../src/lib/stateOwnership";
import { recordProvisionFixtureEvent, waitForProvisionFixtureReply } from "../src/lib/pipelines/provisionFixtureSupervisor";

/* What this file is defending is the shape of the check rather than its
   verdict: the verdict is produced by CI, under the pinned interpreter, on a
   real build. A probe that reaches no modules also reports no failures, so
   every way of arriving at an empty target list has to be a failure here. */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-runtime-test-"));
  roots.push(root);
  for (const file of files) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "");
  }
  return root;
}

test("the probe loads every compiled server runtime and every bundle the build writes", () => {
  const root = fixtureRoot([
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
    path.join(COMPILED_SERVER_DIR, "server.runtime.prod.js"),
    path.join(COMPILED_SERVER_DIR, "app-page.runtime.dev.js"),
    path.join(COMPILED_SERVER_DIR, `${REQUIRED_SERVER_RUNTIME}.map`),
    path.join(BUILT_SERVER_DIR, "middleware.js"),
    path.join(BUILT_SERVER_DIR, "file-scanner-worker.js"),
    path.join(BUILT_SERVER_DIR, "next-font-manifest.js"),
    path.join(BUILT_SERVER_DIR, "chunks", "994.js"),
  ]);

  const modules = servedRuntimeModules(root);

  expect(modules).toContain(path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME));
  expect(modules).toContain(path.join(COMPILED_SERVER_DIR, "server.runtime.prod.js"));
  expect(modules).toContain(path.join(BUILT_SERVER_DIR, "middleware.js"));
  expect(modules).toContain(path.join(BUILT_SERVER_DIR, "file-scanner-worker.js"));
  // The development runtimes are never served, the manifests are data those
  // bundles read, the chunks are reached through the webpack runtime, and a
  // source map is not a module at all.
  expect(modules).not.toContain(path.join(COMPILED_SERVER_DIR, "app-page.runtime.dev.js"));
  expect(modules).not.toContain(path.join(COMPILED_SERVER_DIR, `${REQUIRED_SERVER_RUNTIME}.map`));
  expect(modules).not.toContain(path.join(BUILT_SERVER_DIR, "next-font-manifest.js"));
  expect(modules).not.toContain(path.join(BUILT_SERVER_DIR, "chunks", "994.js"));
});

test("a build the probe cannot find is named, not passed over", () => {
  const root = fixtureRoot([]);

  expect(missingRequiredModules(servedRuntimeModules(root))).toEqual([
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
    path.join(BUILT_SERVER_DIR, "*.js"),
  ]);
});

test("the runtime whose load failure answered 500 on every route is required by name", () => {
  /* Everything else present and that one absent: the framework moved it, or
     renamed it, and the glob quietly went on reporting no failures. */
  const root = fixtureRoot([
    path.join(COMPILED_SERVER_DIR, "server.runtime.prod.js"),
    path.join(BUILT_SERVER_DIR, "middleware.js"),
  ]);

  expect(missingRequiredModules(servedRuntimeModules(root))).toEqual([
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
  ]);
});

test("verification of a directory with no build fails, and says that is what happened", async () => {
  const root = fixtureRoot([]);

  const report = await verifyViewerRuntime(root);

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("no build");
  expect(report.modules.probed).toBe(0);
  expect(report.served).toBeNull();
});

test("a sandbox made inside the installation's own state tree is not read as the operator's", () => {
  /* A stage's scratch directory lives under the state tree, so its TMPDIR is
     the sandbox's parent. Every directory the children resolve has to sit under
     their own temp root, or the ownership rules refuse a valid build. */
  const home = path.join(os.tmpdir(), "llv-operator-home");
  const restore = setStateOwnershipPathsForTests({ home, tempRoots: [] });
  try {
    const sandbox = path.join(home, ".config", "delegatus", "state", "scratch", "stage", "tmp", "llv-viewer-runtime-x");
    const env = sandboxEnvironment(sandbox);
    for (const directory of [env.HOME!, env.XDG_CONFIG_HOME!, path.join(env.XDG_CONFIG_HOME!, "delegatus", "inbox"), env.LLV_STATE_DIR!]) {
      expect({ directory, operatorOwned: isOperatorOwnedDirectory(directory, env) }).toEqual({ directory, operatorOwned: false });
    }
  } finally {
    restore();
  }
});

test("the Codex socket probe fails on a build that does not carry the transport, and names the Viewer", async () => {
  const root = fixtureRoot(["package.json", path.join(BUILT_SERVER_DIR, "chunks", "1.js")]);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.symlinkSync(import.meta.dir, path.join(root, "scripts"), "dir");

  const report = await verifyBuiltCodexSocket(root);

  expect(report.ok).toBe(false);
  expect(report.process).toContain("Viewer");
  expect(report.detail).toContain("carries the Codex socket transport");
  expect(report.evidence).toBeUndefined();
}, 30_000);

test("runtime probes preserve their signal namespace boundary without inheriting state ownership", () => {
  const previous = process.env.LLV_SIGNAL_SANDBOX;
  const boundary = JSON.stringify({ pidNamespace: "pid:[fixture]", userNamespace: "user:[fixture]" });
  process.env.LLV_SIGNAL_SANDBOX = boundary;
  try {
    const env = sandboxEnvironment(path.join(os.tmpdir(), "viewer-probe-fixture"));
    expect(env.LLV_SIGNAL_SANDBOX).toBe(boundary);
    expect(env.LLV_STATE_OWNER).toBeUndefined();
    expect(env.LLV_OWNED_TEST_RUN_CGROUP).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.LLV_SIGNAL_SANDBOX;
    else process.env.LLV_SIGNAL_SANDBOX = previous;
  }
});

test("the output collector keeps a short failure tail yet still finds a frame printed before the tail", () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as unknown as ChildProcess;
  const log = collector(child, "server");
  child.stdout!.emit("data", '{"pipelineId":"baseline","phase":"toolchain-ready"}\n');
  // Two later lanes print far more than the 40-line tail holds.
  for (let lane = 0; lane < 2; lane++) {
    child.stdout!.emit("data", Array.from({ length: 60 }, (_, index) => `lane ${lane} flow ${index}`).join("\n") + "\n");
  }
  expect(log().length).toBe(40);
  expect(log().some(line => line.includes("baseline"))).toBe(false);
  expect(log.search().some(line => line.includes('"pipelineId":"baseline"') && line.includes('"phase":"toolchain-ready"'))).toBe(true);
  // The searched window is byte-bounded, so a flood cannot grow it without limit.
  child.stdout!.emit("data", "x".repeat(300_000));
  expect(log.search().join("\n").length).toBeLessThanOrEqual(128_000);
});

test("provisioning release tracing runs only for a completed App Router build", () => {
  const root = fixtureRoot([path.join(BUILT_SERVER_DIR, "app/api/pipelines/route.js")]);
  expect(hasBuiltPipelineRoute(root)).toBe(false);
  fs.writeFileSync(path.join(root, ".next/BUILD_ID"), "fixture-build\n");
  expect(hasBuiltPipelineRoute(root)).toBe(true);
});

test.each(["delayed", "missing", "late", "stalled", "duplicate", "parked"] as const)("the release fixture checks a %s first-stage attempt separately from provisioning", async scenario => {
  const root = fixtureRoot([]);
  const worktreeDir = path.join(root, "worktree");
  const common = path.join(root, ".git");
  const key = "a".repeat(64);
  const graph = path.join(common, "delegatus-dependencies", "v4", key, "node_modules");
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, "..", "installed.json"), JSON.stringify({ key }));
  fs.mkdirSync(worktreeDir);
  fs.symlinkSync(graph, path.join(worktreeDir, "node_modules"), "junction");
  const planned = "b".repeat(40);
  const lane = {
    state: "running",
    cursor: { stageId: "build", state: "pending" },
    lastPassedCommit: planned,
    worktreeDir,
    stateDetail: scenario === "parked" ? "fixture stage admission refused" : null,
    runs: [{ stageId: "build", attempts: [] as { n: number }[] }],
  };
  let reads = 0;
  const nearDeadline = scenario === "missing" || scenario === "late" || scenario === "stalled";
  const clock = path.join(root, "clock");
  // The peer advances the verifier's clock at request boundaries.
  const setClock = (now: number) => {
    fs.writeFileSync(`${clock}.next`, String(now));
    fs.renameSync(`${clock}.next`, clock);
  };
  setClock(0);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/") {
        return new Response(null, { headers: { "set-cookie": "llv_operator=fixture" } });
      }
      if (request.method === "POST") return Response.json({ pipeline: { id: "fixture" } }, { status: 201 });
      if (request.method === "PATCH") return Response.json({ pipeline: { state: "provisioning" } });
      reads += 1;
      if (reads === 1 && nearDeadline) setClock(58_000);
      if (reads > 2 || (reads === 2 && scenario === "missing")) setClock(60_000);
      if (reads === 2 && scenario === "late") setClock(60_001);
      if (reads === 2 && scenario === "stalled") {
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"pipeline":')); },
        }), { headers: { "content-type": "application/json" } });
      }
      if (scenario === "duplicate") lane.runs[0].attempts = [{ n: 1 }, { n: 2 }];
      if (scenario === "parked") lane.state = "needs_decision";
      if ((scenario === "delayed" || scenario === "late") && reads === 2) lane.runs[0].attempts = [{ n: 1 }];
      return Response.json({ pipeline: lane });
    },
  });
  const verifier = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { readFileSync } from "node:fs";
    import { verifyFixtureLane } from "./verify-provisioning-release.mjs";
    const [origin, root, clock, planned, common] = process.argv.slice(-5);
    Date.now = () => Number(readFileSync(clock, "utf8"));
    const timeouts = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = milliseconds => {
      timeouts.push(milliseconds);
      return timeout(milliseconds);
    };
    const git = async (_cwd, ...args) => {
      if (args.at(-1) === "HEAD") return planned;
      if (args.at(-1) === "--git-common-dir") return common;
      return "";
    };
    try {
      const result = await verifyFixtureLane(origin, root, "unused", git, {}, undefined);
      console.log(JSON.stringify({ result, timeouts }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message, timeouts }));
    }
  `, server.url.origin, root, clock, planned, common], { cwd: import.meta.dir, stdout: "pipe" });
  try {
    const [code, output] = await Promise.all([verifier.exited, new Response(verifier.stdout).text()]);
    expect(code).toBe(0);
    const { result, error, timeouts } = JSON.parse(output);
    if (scenario === "delayed") {
      expect(result).toMatchObject({ lane: "fixture", planned, graph: key });
      expect(reads).toBe(2);
    } else {
      const reason = {
        missing: "no first-stage attempt appeared within 60 s",
        late: "no first-stage attempt appeared within 60 s",
        stalled: "no first-stage attempt appeared within 60 s",
        duplicate: "observed 2 first-stage attempts",
        parked: "fixture stage admission refused",
      }[scenario];
      expect({ error, result }).toMatchObject({ error: expect.stringContaining(reason) });
      expect(reads).toBe(nearDeadline ? 2 : 1);
      if (nearDeadline) expect(timeouts.slice(-2)).toEqual([5_000, 2_000]);
    }
  } finally {
    if (verifier.exitCode === null) verifier.kill("SIGKILL");
    await verifier.exited;
    await server.stop(true);
  }
}, 15_000);

test.each(["check-ignore", "cache-permit"] as const)("private release fixture supervisor holds the %s reply", async reply => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provision-supervisor-test-"));
  roots.push(root);
  const previous = process.env.LLV_PROVISION_FIXTURE_SUPERVISOR;
  process.env.LLV_PROVISION_FIXTURE_SUPERVISOR = root;
  const abort = new AbortController();
  try {
    fs.writeFileSync(path.join(root, `hold-${reply}`), "");
    const held = waitForProvisionFixtureReply(reply, abort.signal, { workerPid: 1234, resultCode: 0 });
    const entered = path.join(root, `entered-${reply}.json`);
    const deadline = Date.now() + 1_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(fs.existsSync(entered)).toBe(true);
    expect(JSON.parse(fs.readFileSync(entered, "utf8"))).toMatchObject({ reply, workerPid: 1234, resultCode: 0 });
    await recordProvisionFixtureEvent("dependency-effect", { effect: "install-cache" });
    fs.writeFileSync(path.join(root, `release-${reply}`), "");
    await held;
    expect(fs.readFileSync(path.join(root, "events.ndjson"), "utf8")).toContain('"effect":"install-cache"');
  } finally {
    if (previous === undefined) delete process.env.LLV_PROVISION_FIXTURE_SUPERVISOR;
    else process.env.LLV_PROVISION_FIXTURE_SUPERVISOR = previous;
  }
});

test("private release fixture supervisor interruption rejects before a late permit reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provision-supervisor-abort-"));
  roots.push(root);
  const previous = process.env.LLV_PROVISION_FIXTURE_SUPERVISOR;
  process.env.LLV_PROVISION_FIXTURE_SUPERVISOR = root;
  const abort = new AbortController();
  try {
    fs.writeFileSync(path.join(root, "hold-cache-permit"), "");
    const held = waitForProvisionFixtureReply("cache-permit", abort.signal, { workerPid: 1234 });
    const entered = path.join(root, "entered-cache-permit.json");
    const deadline = Date.now() + 1_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(fs.existsSync(entered)).toBe(true);
    fs.writeFileSync(path.join(root, "interrupt-cache-permit"), "");
    await expect(held).rejects.toThrow("fixture supervisor interrupted the held reply");
    expect(fs.existsSync(path.join(root, "events.ndjson"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PROVISION_FIXTURE_SUPERVISOR;
    else process.env.LLV_PROVISION_FIXTURE_SUPERVISOR = previous;
  }
});

// Leave room for the verifier's TERM/KILL waits and the fixture's reaping
// checks when other publication checks share the runner.
test.skipIf(process.platform !== "linux").each(["normal", "slow stop", "failed stop", "direct CLI", "portable CLI", "delayed exit", "delayed portable exit", "delayed failed stop", "missing exit"])("verification with %s reaps its served process and detached worker before reporting success", async mode => {
  const root = fixtureRoot([
    "package.json", "node_modules/next/dist/server/node-environment.js",
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
    path.join(BUILT_SERVER_DIR, "middleware.js"), "node_modules/.bin/next",
  ]);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.symlinkSync(import.meta.dir, path.join(root, "scripts"), "dir");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": [path.resolve(import.meta.dir, "../src/*")] } } }));
  const server = path.join(root, "node_modules/.bin/next");
  fs.writeFileSync(server, `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    import { captureProcessIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/processIdentity.ts"))};
    const port = Number(process.argv.at(-1));
    const record = ${JSON.stringify(path.join(root, "served.json"))};
    const worker = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(record, JSON.stringify({ identity: captureProcessIdentity(process.pid), worker: captureProcessIdentity(worker.pid), portable: Number(process.env.LLV_PORTABLE_TEST_RUNNER_PID) === process.pid }));
    Bun.serve({ port, fetch: () => new Response("synthetic viewer") });
    process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
  `);
  const bystander = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  const other = captureProcessIdentity(bystander.pid!);
  let owned: ProcessIdentity | undefined;
  let worker: ProcessIdentity | undefined;
  const savedPath = process.env.PATH;
  if (mode === "slow stop" || mode.includes("failed stop")) {
    const manager = Bun.which("systemctl")!;
    const quoted = "'" + manager.replaceAll("'", "'\"'\"'") + "'";
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\nif [ "$2" = stop ]; then ${mode === "slow stop" ? "sleep 4.5" : "exit 1"}; fi\nexec ${quoted} "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${savedPath}`;
  }
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  const savedBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const savedBoundary = process.env.LLV_SIGNAL_SANDBOX;
  let releaseExit: (() => void) | undefined;
  let delayedPid: number | undefined;
  let observedKernelExit = false;
  const emit = ChildProcess.prototype.emit;
  const pidAlive = procBackend.pidAlive.bind(procBackend);
  const delayedMode = mode.startsWith("delayed ") || mode === "missing exit";
  if (mode === "delayed portable exit") {
    process.env.XDG_RUNTIME_DIR = path.join(root, "absent-runtime");
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}/absent-bus`;
    delete process.env.LLV_SIGNAL_SANDBOX;
  }
  const delivery = delayedMode ? spyOn(ChildProcess.prototype, "emit").mockImplementation(function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === "exit" && this.spawnargs.some(arg => arg.endsWith("/owned-runner.ts")) && this.spawnargs.includes("node_modules/.bin/next")) {
      delayedPid = this.pid;
      const code = this.exitCode, signal = this.signalCode;
      Object.defineProperties(this, { exitCode: { value: null, configurable: true, writable: true }, signalCode: { value: null, configurable: true, writable: true } });
      // Hold the notification until the real cleanup reads the vanished PID.
      releaseExit = () => {
        releaseExit = undefined;
        Object.defineProperties(this, { exitCode: { value: code }, signalCode: { value: signal } });
        emit.call(this, event, ...args);
      };
      return true;
    }
    return emit.call(this, event, ...args);
  }) : undefined;
  const kernel = delayedMode ? spyOn(procBackend, "pidAlive").mockImplementation(pid => {
    const alive = pidAlive(pid);
    if (pid === delayedPid && !alive && !observedKernelExit) {
      observedKernelExit = true;
      if (mode !== "missing exit") setImmediate(() => releaseExit?.());
    }
    return alive;
  }) : undefined;
  try {
    if (mode.includes("failed stop") || mode === "missing exit") {
      await expect(verifyViewerRuntime(root)).rejects.toThrow("service shutdown was not confirmed");
    } else if (mode === "direct CLI" || mode === "portable CLI") {
      const env = { ...process.env };
      delete env.LLV_OWNED_TEST_RUNNER_PID; delete env.LLV_OWNED_TEST_RUN_CGROUP;
      delete env.LLV_PORTABLE_TEST_RUNNER_PID; delete env.LLV_PORTABLE_TEST_WARNING_SHOWN;
      if (mode === "portable CLI") {
        delete env.LLV_SIGNAL_SANDBOX;
        env.XDG_RUNTIME_DIR = path.join(root, "absent-runtime");
        env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}/absent-bus`;
      }
      const cli = spawn(process.execPath, [path.join(import.meta.dir, "verify-viewer-runtime.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let diagnostic = "";
      let output = ""; cli.stdout?.on("data", chunk => { output += String(chunk); });
      cli.stderr?.on("data", chunk => { diagnostic += String(chunk); });
      const deadline = setTimeout(() => cli.kill("SIGKILL"), 8_000);
      try {
        const code = await new Promise(resolve => { cli.once("exit", resolve); cli.once("error", () => resolve(-1)); });
        expect(code, diagnostic + output).toBe(0); expect(JSON.parse(output).ok).toBe(true);
      } finally { clearTimeout(deadline); await stopFixtureProcess(cli); }
    } else {
      const report = await verifyViewerRuntime(root);
      if (!report.ok) throw new Error(JSON.stringify(report));
    }
    if (delayedMode) expect(observedKernelExit).toBe(true);
    const served = JSON.parse(fs.readFileSync(path.join(root, "served.json"), "utf8"));
    ({ identity: owned, worker } = served);
    if (mode.includes("portable")) expect(served.portable).toBe(true);
    if (mode === "delayed exit") expect(served.portable).toBe(false);
    if (mode.includes("failed stop")) {
      // Forced wrapper death is a failed verification. Its kernel watchdog
      // still has to reap the service within the bounded owner-death grace.
      const bound = Date.now() + 3_000;
      while ([owned!, worker!].some(identity => processIdentityStatus(identity) === "alive") && Date.now() < bound) await Bun.sleep(20);
    }
    expect(processIdentityStatus(owned!)).toBe("dead");
    expect(processIdentityStatus(worker!)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("alive");
  } finally {
    releaseExit?.(); delivery?.mockRestore(); kernel?.mockRestore();
    for (const [key, value] of [["XDG_RUNTIME_DIR", savedRuntime], ["DBUS_SESSION_BUS_ADDRESS", savedBus], ["LLV_SIGNAL_SANDBOX", savedBoundary]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    process.env.PATH = savedPath;
    if (!owned && fs.existsSync(path.join(root, "served.json"))) ({ identity: owned, worker } = JSON.parse(fs.readFileSync(path.join(root, "served.json"), "utf8")));
    for (const identity of [owned, worker]) if (identity && processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    const deadline = Date.now() + 2_000;
    while ([owned, worker].some(identity => identity && processIdentityStatus(identity) === "alive") && Date.now() < deadline) await Bun.sleep(20);
    await stopFixtureProcess(bystander);
    if (owned) expect(processIdentityStatus(owned)).toBe("dead");
    if (worker) expect(processIdentityStatus(worker)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("dead");
  }
}, 60_000);
