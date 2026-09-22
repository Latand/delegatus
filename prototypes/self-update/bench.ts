/* The demo bench: a duplicate install pinned to an older commit, its own config
   root, its web process and runtime host, and the prototype pointed at it.

     bun prototypes/self-update/bench.ts start [--at <sha|tag>] [--root <dir>]
     bun prototypes/self-update/bench.ts status [--root <dir>]
     bun prototypes/self-update/bench.ts restart-prototype [--root <dir>]
     bun prototypes/self-update/bench.ts stop [--purge] [--root <dir>]

   Run it with the pinned Bun (~/.cache/llv-bun-1.4.0/bin/bun): it passes its
   own interpreter down to every child. Everything lives under the root
   (default /var/tmp/llv-self-update-bench). Every process it starts is
   recorded by PID and start identity in bench.json, and `stop` signals only
   those recorded process groups. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CANONICAL_REMOTE, type Config } from "./lib/config";
import { childEnv, runtimePaths } from "./lib/env";
import { freePort, isAlive, ManagedProcess, ProcessRegistry, readStartIdentity, sameProcess, signalGroup, type ProcessRecord } from "./lib/processes";
import { managedSpecs, releasePointer } from "./server";
import { memAvailableMb, MIN_AVAILABLE_MB, pumpLines } from "./lib/steps";

const DEFAULT_ROOT = "/var/tmp/llv-self-update-bench";
const SERVER = join(import.meta.dir, "server.ts");

interface Recorded { pid: number; startIdentity: string }
interface BenchFile {
  startedAt: string;
  root: string;
  checkout: string;
  configRoot: string;
  bun: string;
  at: string;
  ports: { web: number; prototype: number };
  pids: { prototype: Recorded | null; web: Recorded | null; runtimeHost: Recorded | null };
  urls: { viewer: string; prototype: string };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function say(line: string): void {
  console.log(`bench: ${line}`);
}

function guardMemory(what: string): void {
  const available = Math.floor(memAvailableMb());
  say(`MemAvailable ${available} MB before ${what}`);
  if (available < MIN_AVAILABLE_MB) {
    throw new Error(`Not enough free memory for ${what} (${available} MB available, ${MIN_AVAILABLE_MB} needed)`);
  }
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}): Promise<string> {
  say(`$ ${command.join(" ")}${options.cwd ? `   (in ${options.cwd})` : ""}`);
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const lines: string[] = [];
  const onLine = (line: string) => {
    lines.push(line);
    if (lines.length > 40) lines.shift();
    if (!options.quiet) console.log(`  ${line}`);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolveCode) => {
    void pumpLines(child.stderr, onLine);
    child.once("error", (error) => { onLine(error.message); resolveCode(127); });
    child.once("close", (exit) => resolveCode(exit ?? 1));
  });
  if (!options.quiet) for (const line of stdout.split("\n").filter(Boolean).slice(-40)) console.log(`  ${line}`);
  if (code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited with ${code}\n${lines.join("\n")}`);
  return stdout;
}

function readBench(root: string): BenchFile | null {
  try { return JSON.parse(readFileSync(join(root, "bench.json"), "utf8")) as BenchFile; }
  catch { return null; }
}

function writeBench(root: string, bench: BenchFile): void {
  writeFileSync(join(root, "bench.json"), `${JSON.stringify(bench, null, 2)}\n`);
}

function recorded(record: ProcessRecord | null): Recorded | null {
  return record ? { pid: record.pid, startIdentity: record.startIdentity } : null;
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return !isAlive(pid);
}

async function stopRecorded(name: string, record: Recorded): Promise<void> {
  if (!sameProcess(record)) {
    say(`${name}: PID ${record.pid} is not running (or is no longer the recorded process); nothing to signal`);
    return;
  }
  say(`${name}: SIGTERM to the process group of PID ${record.pid}`);
  signalGroup(record, "SIGTERM");
  if (await waitGone(record.pid, 10_000)) return say(`${name}: PID ${record.pid} exited`);
  say(`${name}: still running after 10 s, SIGKILL to PID ${record.pid}'s group`);
  signalGroup(record, "SIGKILL");
  say(await waitGone(record.pid, 2_000) ? `${name}: PID ${record.pid} killed` : `${name}: PID ${record.pid} survived SIGKILL`);
}

async function waitHttp(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch { /* not yet */ }
    await Bun.sleep(300);
  }
  throw new Error(`${url} did not answer 200 within ${Math.round(ms / 1000)} s`);
}

function startPrototype(bench: BenchFile): Recorded {
  const logFd = openSync(join(bench.root, "logs", "prototype.log"), "a");
  const prototype = spawn(bench.bun, [
    SERVER, "--checkout", bench.checkout, "--config-root", bench.configRoot, "--web-port", String(bench.ports.web),
    "--port", String(bench.ports.prototype), "--bun", bench.bun,
    "--processes", join(bench.configRoot, "self-update", "processes.json"),
  ], { cwd: import.meta.dir, env: process.env, detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  if (!prototype.pid) throw new Error("the prototype did not start");
  prototype.unref();
  say(`prototype started, PID ${prototype.pid}`);
  return { pid: prototype.pid, startIdentity: readStartIdentity(prototype.pid) ?? "" };
}

/* Replaces the prototype process alone (after an edit to its code). The web
   process and the runtime host keep running; the new prototype adopts them
   from processes.json. */
async function restartPrototype(argv: string[]): Promise<void> {
  const root = resolve(flag(argv, "--root") ?? DEFAULT_ROOT);
  const bench = readBench(root);
  if (!bench) throw new Error(`no bench.json under ${root}`);
  if (bench.pids.prototype) await stopRecorded("prototype", bench.pids.prototype);
  bench.pids.prototype = startPrototype(bench);
  writeBench(root, bench);
  await waitHttp(`${bench.urls.prototype}api/state`, 20_000);
  say(`Self-update ${bench.urls.prototype}`);
}

async function start(argv: string[]): Promise<void> {
  const root = resolve(flag(argv, "--root") ?? DEFAULT_ROOT);
  const at = flag(argv, "--at");
  if (!root.startsWith("/var/tmp/")) throw new Error("The bench root must be under /var/tmp (the /tmp quota is small)");
  const existing = readBench(root);
  if (existing) {
    const live = Object.entries(existing.pids).filter(([, record]) => record && sameProcess(record));
    if (live.length > 0) throw new Error(`A bench is already running under ${root} (${live.map(([name]) => name).join(", ")}); run \`bench.ts stop\` first`);
  }
  if (process.versions.bun?.startsWith("1.3")) {
    say(`warning: running under Bun ${process.versions.bun}; the build needs the pinned Bun (~/.cache/llv-bun-1.4.0/bin/bun)`);
  }
  const bun = process.execPath;
  const checkout = join(root, "checkout");
  const configRoot = join(root, "config");
  const logs = join(root, "logs");
  for (const dir of [root, configRoot, logs, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
  const repository = (await run(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir, quiet: true })).trim();

  if (!existsSync(join(checkout, ".git"))) {
    guardMemory("git clone");
    await run(["git", "clone", "--no-hardlinks", "--no-checkout", repository, checkout]);
  } else {
    say(`reusing the checkout at ${checkout}`);
  }
  await run(["git", "-C", checkout, "remote", "set-url", "origin", CANONICAL_REMOTE]);
  guardMemory("git fetch");
  /* Forced: the clone's main may hold local commits the remote never had. */
  await run(["git", "-C", checkout, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const target = (await run(["git", "-C", checkout, "rev-parse", "--verify", `${at ?? "origin/main~5"}^{commit}`], { quiet: true })).trim();
  await run(["git", "-C", checkout, "checkout", "--detach", target]);

  const bench: BenchFile = {
    startedAt: new Date().toISOString(),
    root,
    checkout,
    configRoot,
    bun,
    at: target,
    ports: { web: 0, prototype: 0 },
    pids: { prototype: null, web: null, runtimeHost: null },
    urls: { viewer: "", prototype: "" },
  };
  const buildEnv = childEnv({ configRoot, webPort: 1 }, "build");
  guardMemory("bun install");
  await run([bun, "install", "--frozen-lockfile"], { cwd: checkout, env: buildEnv });
  guardMemory("bun run build");
  await run([bun, "run", "build"], { cwd: checkout, env: buildEnv, quiet: true });
  say("build finished");

  const webPort = await freePort();
  const prototypePort = await freePort();
  bench.ports = { web: webPort, prototype: prototypePort };
  const config: Config = {
    checkout,
    configRoot,
    webPort,
    port: prototypePort,
    remote: CANONICAL_REMOTE,
    branch: "main",
    pollMinutes: 60,
    bun,
    processesFile: join(configRoot, "self-update", "processes.json"),
  };
  /* A fresh bench runs the checkout itself; a release an earlier run built and
     published is not what this one starts. */
  rmSync(releasePointer(config).file, { force: true });
  const { web: webSpec, host: hostSpec, paths } = managedSpecs(config);
  for (const dir of [paths.state, paths.tmp, paths.cache, dirname(webSpec.logFile)]) mkdirSync(dir, { recursive: true });
  const registry = new ProcessRegistry(config.processesFile);
  writeBench(root, bench);

  try {
    guardMemory("starting the runtime host");
    const host = new ManagedProcess(hostSpec, registry, () => {});
    await host.start();
    bench.pids.runtimeHost = recorded(registry.get("runtime-host"));
    writeBench(root, bench);
    if (host.status.state !== "healthy") throw new Error(`runtime host did not become healthy: ${host.status.error}\n${host.lines().slice(-20).join("\n")}`);
    say(`runtime host healthy, PID ${host.status.pid}, socket ${paths.socket}`);

    guardMemory("starting web");
    const web = new ManagedProcess(webSpec, registry, () => {});
    await web.start();
    bench.pids.web = recorded(registry.get("web"));
    writeBench(root, bench);
    if (web.status.state !== "healthy") throw new Error(`web did not become healthy: ${web.status.error}\n${web.lines().slice(-20).join("\n")}`);
    say(`web healthy, PID ${web.status.pid}, port ${webPort}`);

    bench.pids.prototype = startPrototype(bench);
    writeBench(root, bench);
    await waitHttp(`http://127.0.0.1:${prototypePort}/api/state`, 20_000);
  } catch (error) {
    say("start failed; stopping what this run started");
    await stop(["--root", root]);
    throw error;
  }

  bench.urls = { viewer: `http://127.0.0.1:${webPort}/`, prototype: `http://127.0.0.1:${prototypePort}/` };
  writeBench(root, bench);
  console.log("");
  console.log(`  Viewer (older):   ${bench.urls.viewer}`);
  console.log(`  Self-update:      ${bench.urls.prototype}`);
  console.log(`  Recorded in       ${join(root, "bench.json")}`);
  console.log(`  Stop with         ${bun} ${join(import.meta.dir, "bench.ts")} stop`);
}

/* Stops the prototype first (so it cannot restart anything), then whatever
   web and runtime-host records exist: the ones the bench started and the ones
   the prototype's restarts replaced them with. */
async function stop(argv: string[]): Promise<void> {
  const root = resolve(flag(argv, "--root") ?? DEFAULT_ROOT);
  const bench = readBench(root);
  if (!bench) {
    say(`no bench.json under ${root}; nothing to stop`);
  } else {
    if (bench.pids.prototype) await stopRecorded("prototype", bench.pids.prototype);
    const registry = new ProcessRegistry(join(bench.configRoot, "self-update", "processes.json"));
    const records = registry.read();
    const targets = new Map<number, [string, Recorded]>();
    for (const [name, record] of [
      ["web", records.web ?? null], ["runtime host", records["runtime-host"] ?? null],
      ["web (bench start)", bench.pids.web], ["runtime host (bench start)", bench.pids.runtimeHost],
    ] as [string, Recorded | null][]) {
      if (record && !targets.has(record.pid)) targets.set(record.pid, [name, record]);
    }
    for (const [name, record] of targets.values()) await stopRecorded(name, record);
    for (const role of ["web", "runtime-host"] as const) {
      const record = registry.get(role);
      if (record && !sameProcess(record)) registry.write(role, null);
    }
  }
  if (argv.includes("--purge")) {
    if (!root.startsWith("/var/tmp/")) throw new Error(`refusing to purge ${root}`);
    rmSync(root, { recursive: true, force: true });
    say(`removed ${root}`);
  }
}

function status(argv: string[]): void {
  const root = resolve(flag(argv, "--root") ?? DEFAULT_ROOT);
  const bench = readBench(root);
  if (!bench) return say(`no bench.json under ${root}`);
  const registry = new ProcessRegistry(join(bench.configRoot, "self-update", "processes.json")).read();
  const line = (name: string, record: Recorded | null | undefined) =>
    say(`${name.padEnd(13)} ${record ? `PID ${record.pid} ${sameProcess(record) ? "running" : "not running"}` : "none recorded"}`);
  line("prototype", bench.pids.prototype);
  line("web", registry.web ?? null);
  line("runtime host", registry["runtime-host"] ?? null);
  say(`Viewer ${bench.urls.viewer || "-"}   Self-update ${bench.urls.prototype || "-"}`);
  say(`runtime socket ${runtimePaths(bench.configRoot).socket}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "start") await start(rest);
  else if (command === "stop") await stop(rest);
  else if (command === "status") status(rest);
  else if (command === "restart-prototype") await restartPrototype(rest);
  else {
    console.log("Usage: bun prototypes/self-update/bench.ts start [--at <sha|tag>] [--root <dir>] | status | restart-prototype | stop [--purge]");
    process.exit(command ? 2 : 0);
  }
} catch (error) {
  console.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
