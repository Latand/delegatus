#!/usr/bin/env bun
/* #1248: verify the Viewer's build under the interpreter that will serve it.
 *
 * The Bun pin moved to 1.4.0 once already and was rolled back the same hour.
 * The build had said nothing about the move, because it cannot: `next build`
 * produces the same artifact under either interpreter. The compiled app-page
 * runtime then fails to load below 1.4.0, and a server that cannot load it
 * answers 500 on every route — which is what production got, from a green
 * build and a passing suite.
 *
 * This is the Viewer half of "verified under a runtime". Given a finished
 * build in the working directory it:
 *
 *   1. require()s every compiled Next server runtime and every bundle this
 *      repository builds into `.next/server`, each reported by name; and
 *   2. starts the served application the way `package.json` starts it, on an
 *      ephemeral loopback port, and requires `GET /` to answer 200.
 *
 * The interpreter under test is the one this script runs under, so it is
 * exercised by being used rather than named in a flag:
 *
 *   bun scripts/verify-viewer-runtime.ts        # this bun serves the build
 *
 * Nothing it touches is shared: the loads and the server both run against a
 * private HOME, config, state and temporary directory removed on exit, on a
 * port the kernel hands out. It never binds the stable port and never reads
 * the operator's state directory. `verify-runtime-host.ts` is the other half —
 * the process that owns the stable listener — and the two together are what a
 * Bun pin has to survive before it is proposed for promotion.
 *
 * Exit status is the verdict; the evidence is printed as JSON.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { stopFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { captureProcessIdentity } from "../src/lib/processIdentity";
import { candidatePerformanceDetail, parseCandidatePerformanceReport } from "../src/runtime-host/candidatePerformance";

const USAGE = "usage: bun scripts/verify-viewer-runtime.ts [--load-modules | --codex-socket | --performance [--scale <0..1>]]";

/** The module whose load failure answered 500 on every route (#1248). */
export const REQUIRED_SERVER_RUNTIME = "app-page.runtime.prod.js";
/** Where Next keeps the compiled server runtimes the served application loads. */
export const COMPILED_SERVER_DIR = path.join("node_modules", "next", "dist", "compiled", "next-server");
/** Where this repository's own server bundles land. */
export const BUILT_SERVER_DIR = path.join(".next", "server");
/** Loaded first, as the served application loads it. */
const NODE_ENVIRONMENT = path.join("node_modules", "next", "dist", "server", "node-environment.js");

/** How the module probe names its report inside the child's output. */
const MODULE_REPORT_PREFIX = "[viewer runtime] modules ";
/** A module that has not loaded within this is a failure, not a slow load. */
const MODULE_BUDGET_MS = 180_000;
/** The served application must answer within this of being started. */
const START_BUDGET_MS = 120_000;
const START_POLL_MS = 250;
/** Bounded tail of a child's own output, kept with a failure. */
const LOG_LINES = 40;

export interface ViewerModuleFailure {
  /** Repository-relative, because that is what a reader can go and open. */
  module: string;
  error: string;
}

export interface ViewerRuntimeEvidence {
  checkedAt: string;
  /** What was exercised, for the record: `bun 1.4.0`. */
  runtime: string;
  modules: { probed: number; loaded: number; failures: ViewerModuleFailure[] };
  served: { status: number; bytes: number; readyMs: number } | null;
  ok: boolean;
  detail?: string;
  log?: string[];
}

/**
 * Everything the served application loads out of a finished build, named
 * relative to `root`: the compiled Next server runtimes, and the bundles this
 * repository builds itself. Manifests are data those bundles read rather than
 * modules anyone requires, and the per-route chunks are reached through the
 * webpack runtime rather than by path, so neither is a load the server
 * performs and neither is here.
 */
export function servedRuntimeModules(root: string): string[] {
  const modules = [NODE_ENVIRONMENT];
  for (const directory of [COMPILED_SERVER_DIR, BUILT_SERVER_DIR]) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    const names = fs.readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      if (directory === COMPILED_SERVER_DIR && !name.endsWith(".runtime.prod.js")) continue;
      if (directory === BUILT_SERVER_DIR && name.endsWith("-manifest.js")) continue;
      modules.push(path.join(directory, name));
    }
  }
  return modules;
}

/**
 * What has to be in that list for a clean report to mean anything. A probe
 * that loads nothing also reports no failures, so an absent build — or a
 * rename that empties the glob — has to be a failure here rather than a pass
 * downstream.
 */
export function missingRequiredModules(modules: string[]): string[] {
  const missing: string[] = [];
  if (!modules.includes(path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME))) {
    missing.push(path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME));
  }
  if (!modules.some((module) => module.startsWith(BUILT_SERVER_DIR + path.sep))) {
    missing.push(path.join(BUILT_SERVER_DIR, "*.js"));
  }
  return missing;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "unknown error";
}

/** Load every module in `root`'s build, in this process, and report each one. */
export function loadServedRuntimeModules(root: string): ViewerModuleFailure[] {
  const require = createRequire(path.join(root, "package.json"));
  const failures: ViewerModuleFailure[] = [];
  for (const file of servedRuntimeModules(root)) {
    try {
      require(path.join(root, file));
    } catch (error) {
      failures.push({ module: file, error: firstLine(error) });
    }
  }
  return failures;
}

/** An unused loopback port, claimed and released so the server can bind it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("no ephemeral port was assigned"));
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * The environment both children get. Built rather than inherited, so neither
 * the loads nor the server can reach a live state directory, journal or socket
 * belonging to whoever started this. The image pins production, and what is
 * under test must see the same.
 */
function sandboxEnvironment(sandbox: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_RUNTIME_UI: "1",
    HOME: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    TMPDIR: path.join(sandbox, "tmp"),
    LLV_STATE_DIR: path.join(sandbox, "state"),
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
  };
}

function collector(child: ChildProcess, label: string): () => string[] {
  const lines: string[] = [];
  const collect = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      lines.push(`${label}: ${line}`);
      if (lines.length > LOG_LINES) lines.shift();
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => collect(`failed to start: ${error.message}`));
  return () => [...lines];
}

/**
 * Load the build's server modules in a child under this same interpreter.
 *
 * A child, and not this process, for two reasons the probe found the hard way:
 * a worker bundle keeps a handle open once loaded and never lets its process
 * exit, and a module loaded here would read the caller's own HOME rather than
 * the private one. A module that never returns is a failure at the budget.
 */
async function probeModules(root: string, sandbox: string): Promise<{ failures: ViewerModuleFailure[]; log: string[]; detail?: string }> {
  const child = spawn(process.execPath, [path.join(root, "scripts", "verify-viewer-runtime.ts"), "--load-modules"], {
    cwd: root,
    env: sandboxEnvironment(sandbox),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  const log = collector(child, "modules");
  let overran = false;
  const timer = setTimeout(() => { overran = true; child.kill("SIGKILL"); }, MODULE_BUDGET_MS);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  const marker = output.lastIndexOf(MODULE_REPORT_PREFIX);
  if (marker < 0) {
    /* A module that never returns is a module that did not load, so the budget
       is a verdict rather than a retry. */
    const why = overran
      ? `the module probe did not finish within ${Math.round(MODULE_BUDGET_MS / 1_000)}s`
      : code === null
        ? "the module probe could not be started"
        : `the module probe exited ${code} without reporting`;
    return { failures: [], log: log(), detail: why };
  }
  const line = output.slice(marker + MODULE_REPORT_PREFIX.length).split("\n")[0] ?? "";
  return { failures: JSON.parse(line) as ViewerModuleFailure[], log: log() };
}

/* The Codex socket transport (#2922) runs inside the Viewer's compiled
 * Next server. Bundled there, ws resolved its optional `bufferutil` peer to an
 * empty module, and every client frame of 48 bytes or more threw `b.mask is
 * not a function`. Unit tests import ws unbundled, and the module loads and
 * GET / above write no frame, so production found it first. This probe takes
 * the transport out of the served build itself and round-trips one masked
 * frame through it to a stub app-server on a private unix socket. */

/** A string only the Codex socket transport's module carries; it finds the
 *  transport's compiled module in the build. */
export const CODEX_SOCKET_MARKER = "Codex callback connection is closed";
const CODEX_SOCKET_REPORT_PREFIX = "[viewer runtime] codex-socket ";
const CODEX_SOCKET_BUDGET_MS = 60_000;
/** Above ws's 48-byte cut-over, where a client frame is masked through `bufferutil`. */
const CODEX_SOCKET_FRAME_BYTES = 1_024;
const CODEX_SOCKET_REPLY_MS = 10_000;
/** The transport refuses a socket directory longer than this (its sun_path budget). */
const CODEX_SOCKET_ROOT_BYTES = 72;

/** A stub Codex app-server: listens where `--listen unix://…` says and echoes. */
const CODEX_STUB_SERVER = `
const file = process.argv[process.argv.indexOf("--listen") + 1].replace(/^unix:\\/\\//, "");
Bun.serve({
  unix: file,
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }); },
  websocket: { message(socket, message) { socket.send(message); } },
});
require("node:fs").chmodSync(file, 0o600);
`;

export interface CodexSocketEvidence {
  /** The compiled route entry whose module graph supplied the transport. */
  entry: string;
  /** The transport's webpack module id inside that graph. */
  module: string;
  frameBytes: number;
  roundTripMs: number;
}

interface CodexTransportLike {
  readonly pid: number;
  readonly stdin: NodeJS.WritableStream & { write(chunk: string, callback: (error?: Error | null) => void): boolean };
  readonly stdout: NodeJS.ReadableStream;
  once(event: "exit", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  disconnect(): void;
}
interface CodexTransportClass {
  launch(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<CodexTransportLike>;
  reconnect(owner: unknown): Promise<CodexTransportLike>;
}

function routeEntries(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? routeEntries(absolute) : entry.name === "route.js" ? [absolute] : [];
  });
}

/** The transport class as the served build compiled it, reached the way the
 *  server reaches it: through a real route entry and the webpack runtime. */
export function loadBuiltCodexSocketTransport(root: string): { entry: string; module: string; transport: CodexTransportClass } {
  const server = path.join(root, BUILT_SERVER_DIR);
  const chunks = path.join(server, "chunks");
  const holders = fs.existsSync(chunks)
    ? fs.readdirSync(chunks).filter(name => name.endsWith(".js") && fs.readFileSync(path.join(chunks, name), "utf8").includes(CODEX_SOCKET_MARKER)).map(name => name.slice(0, -3))
    : [];
  if (holders.length === 0) throw new Error(`no compiled chunk in ${path.join(BUILT_SERVER_DIR, "chunks")} carries the Codex socket transport`);
  const entry = routeEntries(path.join(server, "app")).sort().find(file => {
    const text = fs.readFileSync(file, "utf8");
    return holders.some(id => new RegExp(`[\\[,]${id}[,\\]]`).test(text));
  });
  if (!entry) throw new Error(`no compiled route loads the chunks carrying the Codex socket transport (${holders.join(", ")})`);
  const require = createRequire(path.join(root, "package.json"));
  require(entry);
  const runtime = require(path.join(server, "webpack-runtime.js")) as ((id: string) => Record<string, unknown>) & { m: Record<string, unknown> };
  for (const id of Object.keys(runtime.m).filter(id => String(runtime.m[id]).includes(CODEX_SOCKET_MARKER))) {
    const transport = Object.values(runtime(id)).find(value => typeof value === "function"
      && typeof (value as Partial<CodexTransportClass>).launch === "function"
      && typeof (value as Partial<CodexTransportClass>).reconnect === "function");
    if (transport) return { entry: path.relative(root, entry), module: id, transport: transport as CodexTransportClass };
  }
  throw new Error(`${path.relative(root, entry)} loaded, but no module in its graph exports the Codex socket transport`);
}

/** Launch the built transport against the stub, write one masked frame and
 *  require the same bytes back. Runs in the child, under the sandbox. */
export async function roundTripBuiltCodexSocket(root: string): Promise<CodexSocketEvidence> {
  const { entry, module: moduleId, transport: Transport } = loadBuiltCodexSocketTransport(root);
  const stub = path.join(os.tmpdir(), "codex-stub-app-server.ts");
  fs.writeFileSync(stub, CODEX_STUB_SERVER);
  const transport = await Transport.launch(process.execPath, [stub], { env: process.env });
  const stubIdentity = captureProcessIdentity(transport.pid);
  const exited = new Promise<void>(resolve => transport.once("exit", resolve));
  try {
    const frame = JSON.stringify({ id: 1, method: "delegatus/probe", params: { padding: "x".repeat(CODEX_SOCKET_FRAME_BYTES) } });
    const started = Date.now();
    const echoed = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => reject(new Error(`the stub app-server echoed nothing within ${CODEX_SOCKET_REPLY_MS / 1_000}s`)), CODEX_SOCKET_REPLY_MS);
      const settle = (error: Error | null, line?: string) => { clearTimeout(timer); if (error) reject(error); else resolve(line!); };
      transport.stdout.on("data", chunk => {
        buffered += String(chunk);
        const end = buffered.indexOf("\n");
        if (end >= 0) settle(null, buffered.slice(0, end));
      });
      transport.stdin.once("error", error => settle(error));
      // ws throws out of `send` synchronously when it cannot mask the frame.
      try { transport.stdin.write(`${frame}\n`, error => { if (error) settle(error); }); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
    if (echoed !== frame) throw new Error(`the stub app-server echoed ${echoed.length} bytes for a ${frame.length}-byte frame`);
    return { entry, module: moduleId, frameBytes: Buffer.byteLength(frame), roundTripMs: Date.now() - started };
  } finally {
    transport.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
    transport.disconnect();
    await stopFixtureIdentity(stubIdentity);
  }
}

/** A sandbox HOME short enough for the transport's private socket directory. */
function codexSocketSandbox(): string {
  const preferred = fs.realpathSync(os.tmpdir());
  const sample = path.join(preferred, "llv-codex-socket-XXXXXX", ".cache", "delegatus", "s");
  const base = Buffer.byteLength(sample) <= CODEX_SOCKET_ROOT_BYTES || process.platform === "win32" ? preferred : "/tmp";
  return fs.mkdtempSync(path.join(base, "llv-codex-socket-"));
}

/** The probe above in a child under this interpreter and a private sandbox. */
export async function verifyBuiltCodexSocket(root: string): Promise<{ ok: boolean; runtime: string; process: string; evidence?: CodexSocketEvidence; detail?: string; log?: string[] }> {
  const runtime = `bun ${Bun.version}`;
  const processName = "Viewer (compiled Next server, .next/server)";
  const sandbox = codexSocketSandbox();
  fs.mkdirSync(path.join(sandbox, "tmp"), { recursive: true, mode: 0o700 });
  try {
    const child = spawn(process.execPath, [path.join(root, "scripts", "verify-viewer-runtime.ts"), "--codex-socket-child"], {
      cwd: root,
      env: sandboxEnvironment(sandbox),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    const log = collector(child, "codex-socket");
    const timer = setTimeout(() => child.kill("SIGKILL"), CODEX_SOCKET_BUDGET_MS);
    const code = await new Promise<number | null>(resolve => { child.once("error", () => resolve(null)); child.once("exit", resolve); });
    clearTimeout(timer);
    const marker = output.lastIndexOf(CODEX_SOCKET_REPORT_PREFIX);
    if (marker < 0) return { ok: false, runtime, process: processName, detail: `the Codex socket probe exited ${code} without reporting`, log: log() };
    const report = JSON.parse(output.slice(marker + CODEX_SOCKET_REPORT_PREFIX.length).split("\n")[0] ?? "") as { evidence?: CodexSocketEvidence; error?: string };
    return report.evidence
      ? { ok: true, runtime, process: processName, evidence: report.evidence }
      : { ok: false, runtime, process: processName, detail: report.error ?? "no detail" };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * Start the served application — the same command `package.json` starts it
 * with, under this interpreter — and ask it for the document once it answers.
 * Any status counts as "answered": what the status IS is the assertion, and
 * accepting one before reading is the mistake that let a 500 pass for a page.
 */
async function serveOnce(root: string, sandbox: string): Promise<{ status: number; bytes: number; readyMs: number; log: string[]; detail?: string }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const contained = process.platform === "linux" && Boolean(process.env.LLV_OWNED_TEST_RUN_CGROUP);
  const command = [process.execPath, "--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)];
  // A serving Viewer starts background workers. Within a gate, give this
  // deliberate probe lifetime its own service so stopping it ends those forks
  // too, without concealing leftovers from the enclosing run's standing guard.
  const child = spawn(process.execPath, contained ? [path.join(import.meta.dir, "owned-runner.ts"), ...command] : command.slice(1), {
    cwd: root,
    env: {
      ...sandboxEnvironment(sandbox), PORT: String(port),
      ...(contained ? {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        LLV_OWNED_RUN_TIMEOUT_MS: String(START_BUDGET_MS + 10_000),
        LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)),
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = collector(child, "server");
  let exited = false;
  child.once("exit", () => { exited = true; });
  const started = Date.now();
  try {
    for (;;) {
      if (exited) return { status: 0, bytes: 0, readyMs: Date.now() - started, log: log(), detail: "the served application exited before it answered" };
      try {
        const probe = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
        await probe.arrayBuffer();
        break;
      } catch {
        if (Date.now() - started >= START_BUDGET_MS) {
          return {
            status: 0,
            bytes: 0,
            readyMs: START_BUDGET_MS,
            log: log(),
            detail: `the served application did not answer within ${Math.round(START_BUDGET_MS / 1_000)}s of starting`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
      }
    }
    const readyMs = Date.now() - started;
    try {
      const response = await fetch(origin, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      return { status: response.status, bytes: body.length, readyMs, log: log() };
    } catch (error) {
      /* It answered the readiness probe and then did not answer this. Whatever
         it was, the document did not arrive, and the log says what the server
         made of it. */
      return { status: 0, bytes: 0, readyMs, log: log(), detail: `the served application dropped GET /: ${firstLine(error)}` };
    }
  } finally {
    // The service's TERM/KILL budget is two seconds. Its original outer handle
    // waits for systemd-run and the exact-unit stop before it exits.
    await stopFixtureProcess(child, contained ? 7_000 : 500, contained ? 10_000 : 2_000);
    if (contained && (child.signalCode !== null || ![0, 143].includes(child.exitCode ?? -1))) {
      throw new Error("served probe service shutdown was not confirmed");
    }
  }
}

export async function verifyViewerRuntime(root: string): Promise<ViewerRuntimeEvidence> {
  const checkedAt = new Date().toISOString();
  const runtime = `bun ${Bun.version}`;
  const modules = servedRuntimeModules(root);
  const missing = missingRequiredModules(modules);
  const verdict = (
    probed: number,
    failures: ViewerModuleFailure[],
    served: ViewerRuntimeEvidence["served"],
    failure: { detail: string; log: string[] } | null,
  ): ViewerRuntimeEvidence => ({
    checkedAt,
    runtime,
    modules: { probed, loaded: probed - failures.length, failures },
    served,
    ok: failure === null,
    ...(failure ? { detail: failure.detail } : {}),
    ...(failure && failure.log.length > 0 ? { log: failure.log } : {}),
  });

  if (missing.length > 0) {
    return verdict(0, [], null, { detail: `there is no build to load here: ${missing.join(", ")} is missing`, log: [] });
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-runtime-"));
  fs.mkdirSync(path.join(sandbox, "tmp"), { recursive: true, mode: 0o700 });
  try {
    const loads = await probeModules(root, sandbox);
    if (loads.detail) return verdict(modules.length, loads.failures, null, { detail: loads.detail, log: loads.log });
    if (loads.failures.length > 0) {
      /* The names here and the errors in `failures`: one failing load explains
         the other four, and repeating the same sentence five times buries it. */
      const named = loads.failures.map((failure) => failure.module).join(", ");
      return verdict(modules.length, loads.failures, null, {
        detail: `${loads.failures.length} of ${modules.length} server modules did not load under ${runtime}`
          + ` (${named}): ${loads.failures[0].error}`,
        log: [],
      });
    }

    const served = await serveOnce(root, sandbox);
    const evidence = { status: served.status, bytes: served.bytes, readyMs: served.readyMs };
    if (served.detail) return verdict(modules.length, [], evidence, { detail: served.detail, log: served.log });
    if (served.status !== 200) {
      return verdict(modules.length, [], evidence, {
        detail: `the served application answered GET / with ${served.status} under ${runtime}`,
        log: served.log,
      });
    }
    if (served.bytes === 0) {
      /* A 200 carrying nothing is a served document in the same sense an error
         page is one: the status was the only thing that arrived. */
      return verdict(modules.length, [], evidence, {
        detail: `the served application answered GET / with 200 and an empty document under ${runtime}`,
        log: served.log,
      });
    }
    return verdict(modules.length, [], evidence, null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (argv.includes("--codex-socket-child")) {
    let report: { evidence?: CodexSocketEvidence; error?: string };
    try { report = { evidence: await roundTripBuiltCodexSocket(process.cwd()) }; }
    catch (error) { report = { error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error) }; }
    console.log(CODEX_SOCKET_REPORT_PREFIX + JSON.stringify(report));
    /* The loaded route graph holds handles open. */
    process.exit(0);
  }
  if (argv.includes("--load-modules")) {
    console.log(MODULE_REPORT_PREFIX + JSON.stringify(loadServedRuntimeModules(process.cwd())));
    /* A loaded worker bundle holds a handle open, and this process has said
       everything it has to say. */
    process.exit(0);
  }

  // The direct command prescribed by CI needs the same containment as a hook.
  // Redirect before probing, and bind the service to this original caller so
  // its hard death cannot leave the redirected verifier behind.
  if (process.platform === "linux" && !(Number(process.env.LLV_OWNED_TEST_RUNNER_PID) === process.pid
    && fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").some(line => line === `0::${process.env.LLV_OWNED_TEST_RUN_CGROUP}`))) {
    const runner = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), process.execPath, import.meta.path, ...argv], {
      env: { ...process.env, LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) }, stdio: "inherit",
    });
    process.on("SIGTERM", () => runner.kill("SIGTERM"));
    process.on("SIGINT", () => runner.kill("SIGTERM"));
    const code = await new Promise<number>(resolve => {
      runner.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal === "SIGTERM" ? 143 : 137)));
      runner.once("error", () => resolve(1));
    });
    process.exit(code);
  }

  if (argv.includes("--codex-socket")) {
    const report = await verifyBuiltCodexSocket(process.cwd());
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      console.error(`codex socket verification failed in the ${report.process} under ${report.runtime}: ${(report.detail ?? "no detail").split("\n")[0]}`);
      process.exit(1);
    }
    console.error(`codex socket verified in the ${report.process} under ${report.runtime}:`
      + ` ${report.evidence!.entry} launched the transport and round-tripped a ${report.evidence!.frameBytes}-byte masked frame`
      + ` through a stub app-server in ${report.evidence!.roundTripMs} ms`);
    process.exit(0);
  }

  if (argv.includes("--performance")) {
    /* #2761: the Viewer's registry and projection performance against retained
       history, the gate `verify-candidate` runs inside the candidate image.
       Same runner, same bounds, this checkout's code and interpreter. */
    const scale = argv[argv.indexOf("--scale") + 1];
    const gate = spawn(process.execPath, [
      "run", path.join("src", "runtime-host", "candidatePerformanceRun.ts"),
      ...(argv.includes("--scale") && scale ? ["--scale", scale] : []),
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    gate.stdout?.on("data", (chunk) => { output += String(chunk); });
    await new Promise((resolve) => gate.once("exit", resolve));
    const performance = parseCandidatePerformanceReport(output);
    console.log(JSON.stringify(performance, null, 2));
    console.error(performance.ok
      ? `viewer performance verified under ${performance.runtime} against ${performance.measurements?.dataset.rows} registry rows`
      : `viewer performance failed under ${performance.runtime}: ${candidatePerformanceDetail(performance)}`);
    process.exit(performance.ok ? 0 : 1);
  }

  const report = await verifyViewerRuntime(process.cwd());
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(`viewer verification failed under ${report.runtime}: ${report.detail ?? "no detail"}`);
    process.exit(1);
  }
  console.error(
    `viewer verified under ${report.runtime}:`
    + ` ${report.modules.loaded}/${report.modules.probed} server modules loaded`
    + ` and GET / answered ${report.served?.status} in ${report.served?.bytes} bytes`
    + ` ${Math.round((report.served?.readyMs ?? 0) / 1_000)}s after start`,
  );
  process.exit(0);
}
