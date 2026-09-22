/* Self-update prototype: one Bun server, one page. Manages one install — a
   checkout, its isolated config root, its web process and its runtime host —
   and shows how it updates itself and restarts each process on request.
   Imports nothing from src/, bin/ or scripts/: the checkout it manages may be
   older than this file. Run: bun prototypes/self-update/server.ts --help */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "./lib/config";
import { childEnv, runtimePaths } from "./lib/env";
import { checkForUpdate, readRevision, type CheckOutcome } from "./lib/git";
import { ManagedProcess, ProcessRegistry, runtimeHostProbe, webProbe } from "./lib/processes";
import { ReleasePointer } from "./lib/release";
import {
  applyCheck, Changes, initialCheck, STEP_NAMES,
  type Busy, type CheckSlice, type ProcessStatus, type ProcessView, type Revision, type Snapshot, type StepName, type UpdateState,
} from "./lib/state";
import { realPorts, UpdateRunner } from "./lib/steps";

export interface RunnerPort {
  state: UpdateState;
  start(target: string, meta?: { short?: string; version?: string }): Promise<void>;
  retry(): Promise<void>;
  logPath(step: StepName): string;
}

export interface ProcessPort {
  status: ProcessStatus;
  restart(): Promise<void>;
  checkHealth(): Promise<void>;
  lines(): string[];
}

export interface ServerDeps {
  changes: Changes;
  checker(): Promise<CheckOutcome>;
  /* The newest built release: what the next start or restart runs. */
  readInstalled(): Promise<Revision>;
  /* Version and date of a revision a process was started from. */
  describe(revision: string): Promise<Revision>;
  runner: RunnerPort;
  web: ProcessPort;
  host: ProcessPort;
  info: { checkout: string; remote: string; branch: string; pollMinutes: number; webPort: number };
  /* 0 turns the health ticker off (tests drive health themselves). */
  healthIntervalMs: number;
  /* Run a check as soon as the server starts. */
  checkOnBoot?: boolean;
}

const UI_DIR = join(import.meta.dir, "ui");
const SSE_MIN_GAP_MS = 250;
const KEEPALIVE_MS = 15_000;
const PROCESS_TAIL = 40;
const UNKNOWN_REVISION: Revision = { version: "unknown", sha: "", short: "unknown", date: "" };

class App {
  busy: Busy = null;
  slice: CheckSlice = initialCheck();
  private checking: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly described = new Map<string, Revision>();
  private readonly describing = new Set<string>();

  constructor(private readonly deps: ServerDeps) {}

  /* What a live process serves: its recorded revision, with version and date
     once they are read. */
  private serving(port: ProcessPort): Revision | null {
    const { pid, revision } = port.status;
    if (pid === null || !revision) return null;
    return this.described.get(revision) ?? { version: "", sha: "", short: revision, date: "" };
  }

  /* Reads version and date for any process revision not seen before; emits
     once they arrive. */
  describeServing(): void {
    for (const port of [this.deps.web, this.deps.host]) {
      const revision = port.status.pid !== null ? port.status.revision : null;
      if (!revision || this.described.has(revision) || this.describing.has(revision)) continue;
      this.describing.add(revision);
      void this.deps.describe(revision)
        .then((described) => { this.described.set(revision, { ...described, short: revision }); })
        .catch(() => { this.described.set(revision, { version: "", sha: "", short: revision, date: "" }); })
        .finally(() => { this.describing.delete(revision); this.deps.changes.emit(); });
    }
  }

  snapshot(): Snapshot {
    const { deps } = this;
    const view = (port: ProcessPort): ProcessView => ({ ...port.status, tail: port.lines().slice(-PROCESS_TAIL) });
    return {
      installed: this.slice.installed ?? UNKNOWN_REVISION,
      serving: { web: this.serving(deps.web), runtimeHost: this.serving(deps.host) },
      available: this.slice.available,
      check: this.slice.check,
      update: deps.runner.state,
      processes: { web: view(deps.web), runtimeHost: view(deps.host) },
      busy: this.busy,
      meta: { ...deps.info, serverTime: new Date().toISOString() },
    };
  }

  async refreshInstalled(): Promise<void> {
    try {
      this.slice = { ...this.slice, installed: await this.deps.readInstalled() };
    } catch { /* keeps the previous value; the next check reports the error */ }
    this.deps.changes.emit();
  }

  /* A check may run beside a restart but never beside an update: a finished
     update moves the installed release the check compares against. A second
     request while one runs joins it. */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    this.slice = { ...this.slice, check: { ...this.slice.check, state: "checking" } };
    this.deps.changes.emit();
    this.checking = (async () => {
      try {
        const outcome = await this.deps.checker();
        this.slice = applyCheck(this.slice, outcome, new Date(), this.deps.info.pollMinutes, this.deps.info.branch);
      } catch (error) {
        const failed: CheckOutcome = { ok: false, error: error instanceof Error ? error.message : String(error), installed: null };
        this.slice = applyCheck(this.slice, failed, new Date(), this.deps.info.pollMinutes, this.deps.info.branch);
      } finally {
        this.checking = null;
        this.schedulePoll();
        this.deps.changes.emit();
      }
    })();
    return this.checking;
  }

  schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const at = this.slice.check.nextPollAt ? Date.parse(this.slice.check.nextPollAt) : Date.now() + this.deps.info.pollMinutes * 60_000;
    this.pollTimer = setTimeout(() => {
      if (this.busy === "update") this.schedulePollIn(60_000);
      else void this.check();
    }, Math.max(1_000, at - Date.now()));
  }

  private schedulePollIn(ms: number): void {
    this.slice = { ...this.slice, check: { ...this.slice.check, nextPollAt: new Date(Date.now() + ms).toISOString() } };
    this.schedulePoll();
  }

  stopTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  runAction(busy: Exclude<Busy, null>, action: () => Promise<void>): void {
    this.busy = busy;
    this.deps.changes.emit();
    void action().catch(() => { /* the port reports its own failure in its state */ }).finally(async () => {
      this.busy = null;
      if (busy === "update") {
        await this.refreshInstalled();
        if (this.deps.runner.state.state === "done") void this.check();
      }
      this.deps.changes.emit();
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function refusal(status: number, error: string, app: App): Response {
  return json({ error, snapshot: app.snapshot() }, status);
}

/* Transpiled once per change of app.ts, so an edited page is served without a restart. */
let transpiledApp: { mtimeMs: number; code: string } | null = null;
function appJs(): string {
  const path = join(UI_DIR, "app.ts");
  const { mtimeMs } = statSync(path);
  if (transpiledApp?.mtimeMs !== mtimeMs) {
    transpiledApp = { mtimeMs, code: new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(path, "utf8")) };
  }
  return transpiledApp.code;
}

export interface RunningServer { port: number; app: App; stop(): void }

export function createServer(deps: ServerDeps, options: { port: number; hostname?: string }): RunningServer {
  const app = new App(deps);
  const clients = new Set<(payload: string) => void>();
  let lastSent = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;

  /* At most one state event per 250 ms; the first change after a quiet gap
     goes out at once. */
  const broadcast = () => {
    pending = null;
    lastSent = Date.now();
    const payload = `event: state\ndata: ${JSON.stringify(app.snapshot())}\n\n`;
    for (const send of clients) send(payload);
  };
  const offServing = deps.changes.on(() => app.describeServing());
  const offChanges = deps.changes.on(() => {
    if (pending || clients.size === 0) return;
    pending = setTimeout(broadcast, Math.max(0, lastSent + SSE_MIN_GAP_MS - Date.now()));
  });

  const events = (request: Request): Response => {
    let cleanup = () => {};
    const stream = new ReadableStream<string>({
      start(controller) {
        const send = (payload: string) => {
          try { controller.enqueue(payload); } catch { cleanup(); }
        };
        const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
        cleanup = () => {
          clearInterval(keepalive);
          clients.delete(send);
        };
        clients.add(send);
        send(`retry: 2000\nevent: state\ndata: ${JSON.stringify(app.snapshot())}\n\n`);
        request.signal.addEventListener("abort", () => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        });
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" },
    });
  };

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return new Response(Bun.file(join(UI_DIR, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (method === "GET" && pathname === "/ui/app.js") {
        return new Response(appJs(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      }
      if (method === "GET" && pathname === "/ui/app.css") {
        return new Response(Bun.file(join(UI_DIR, "app.css")), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
      }
      if (method === "GET" && pathname === "/api/state") return json(app.snapshot());
      if (method === "GET" && pathname === "/api/events") return events(request);
      const log = /^\/api\/steps\/([a-z]+)\/log$/.exec(pathname);
      if (method === "GET" && log) {
        const step = log[1] as StepName;
        if (!STEP_NAMES.includes(step)) return new Response("Unknown step\n", { status: 404 });
        const path = deps.runner.logPath(step);
        const text = existsSync(path) ? readFileSync(path, "utf8") : "";
        return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      }
      if (method === "POST" && pathname === "/api/check") {
        if (app.busy === "update") return refusal(409, "An update is running", app);
        void app.check();
        return json(app.snapshot(), 202);
      }
      if (method === "POST" && pathname === "/api/update") {
        if (app.busy) return refusal(409, `Busy: ${app.busy}`, app);
        const available = app.slice.available;
        if (app.slice.check.state !== "update-available" || !available) return refusal(409, "No update is available; run a check first", app);
        app.runAction("update", () => deps.runner.start(available.sha, { short: available.short, version: available.version }));
        return json(app.snapshot(), 202);
      }
      if (method === "POST" && pathname === "/api/update/retry") {
        if (app.busy) return refusal(409, `Busy: ${app.busy}`, app);
        if (deps.runner.state.state !== "failed") return refusal(409, "Only a failed update can be retried", app);
        app.runAction("update", () => deps.runner.retry());
        return json(app.snapshot(), 202);
      }
      if (method === "POST" && pathname === "/api/restart/web") {
        if (app.busy) return refusal(409, `Busy: ${app.busy}`, app);
        app.runAction("restart-web", () => deps.web.restart());
        return json(app.snapshot(), 202);
      }
      if (method === "POST" && pathname === "/api/restart/runtime-host") {
        let body: unknown = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if ((body as { confirm?: unknown } | null)?.confirm !== true) {
          return refusal(400, "Restarting the runtime host needs {\"confirm\":true}", app);
        }
        if (app.busy) return refusal(409, `Busy: ${app.busy}`, app);
        app.runAction("restart-runtime-host", () => deps.host.restart());
        return json(app.snapshot(), 202);
      }
      return new Response("Not found\n", { status: 404 });
    },
  });

  const healthTimer = deps.healthIntervalMs > 0
    ? setInterval(() => { void deps.web.checkHealth(); void deps.host.checkHealth(); }, deps.healthIntervalMs)
    : null;
  void app.refreshInstalled();
  app.describeServing();
  if (deps.checkOnBoot) void app.check();

  return {
    port: server.port!,
    app,
    stop() {
      offChanges();
      offServing();
      if (pending) clearTimeout(pending);
      if (healthTimer) clearInterval(healthTimer);
      app.stopTimers();
      server.stop(true);
    },
  };
}

/* Where the installed-release pointer and the release directories live. */
export function releasePointer(config: Config): ReleasePointer {
  return new ReleasePointer(join(config.configRoot, "self-update", "release.json"), config.checkout);
}

export function releasesDir(config: Config): string {
  return join(config.configRoot, "self-update", "releases");
}

/* The two managed processes, started exactly as bin/cli.mjs starts a packaged
   install's (runtime host first, then `next start`), under the isolated root,
   each from the installed release as it stands when that start happens. */
export function managedSpecs(config: Config) {
  const paths = runtimePaths(config.configRoot);
  const logs = join(config.configRoot, "self-update", "logs");
  const releases = releasePointer(config);
  const cwd = () => releases.current().dir;
  const revision = () => releases.current().sha.slice(0, 7) || null;
  const web = {
    role: "web" as const,
    command: [config.bun, "--bun", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(config.webPort)],
    cwd,
    env: childEnv(config, "web"),
    port: config.webPort,
    socket: null,
    probe: webProbe(config.webPort),
    readyBudgetMs: 90_000,
    readyPollMs: 500,
    readyTimeout: "No HTTP 200 within 90 s",
    logFile: join(logs, "web.log"),
    revision,
  };
  const host = {
    role: "runtime-host" as const,
    command: [config.bun, "--bun", "src/runtime-host/main.ts"],
    cwd,
    env: childEnv(config, "runtime-host"),
    port: null,
    socket: paths.socket,
    probe: runtimeHostProbe(paths.socket, paths.fence),
    readyBudgetMs: 15_000,
    readyPollMs: 100,
    readyTimeout: "Socket not ready within 15 s",
    logFile: join(logs, "runtime-host.log"),
    revision,
  };
  return { web, host, paths, logs };
}

const USAGE = `Usage: bun prototypes/self-update/server.ts --checkout <dir> --config-root <dir> --web-port <n>
  [--port <n>] [--remote <url>] [--branch <name>] [--poll-minutes <n>] [--bun <path>]
  [--processes <file>] [--allow-any-root]
Environment: SELF_UPDATE_CHECKOUT, SELF_UPDATE_CONFIG_ROOT, SELF_UPDATE_WEB_PORT, SELF_UPDATE_PORT,
  SELF_UPDATE_REMOTE, SELF_UPDATE_BRANCH, SELF_UPDATE_POLL_MINUTES, SELF_UPDATE_BUN`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) { console.log(USAGE); return; }
  let config: Config;
  try {
    config = parseConfig(argv, process.env, homedir());
  } catch (error) {
    console.error(`self-update: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  if (!existsSync(join(config.checkout, ".git"))) {
    console.error(`self-update: ${config.checkout} is not a git checkout`);
    process.exit(2);
  }
  const { web: webSpec, host: hostSpec, paths, logs } = managedSpecs(config);
  for (const dir of [paths.state, paths.tmp, paths.cache, logs]) mkdirSync(dir, { recursive: true });

  const changes = new Changes();
  const emit = () => changes.emit();
  const registry = new ProcessRegistry(config.processesFile);
  const web = new ManagedProcess(webSpec, registry, emit);
  const host = new ManagedProcess(hostSpec, registry, emit);
  web.adopt();
  host.adopt();
  const releases = releasePointer(config);
  const ports = realPorts((release) => releases.publish(release));
  const runner = new UpdateRunner(
    {
      checkout: config.checkout,
      remote: config.remote,
      branch: config.branch,
      bun: config.bun,
      logDir: join(config.configRoot, "self-update", "steps"),
      releasesDir: releasesDir(config),
      env: { ...childEnv(config, "build"), GIT_TERMINAL_PROMPT: "0" },
    },
    ports,
    emit,
  );
  const running = createServer({
    changes,
    checker: () => checkForUpdate({ checkout: config.checkout, remote: config.remote, branch: config.branch, installed: releases.current().sha || "HEAD" }),
    readInstalled: () => readRevision(config.checkout, releases.current().sha || "HEAD"),
    describe: (revision) => readRevision(config.checkout, revision),
    runner,
    web,
    host,
    info: { checkout: config.checkout, remote: config.remote, branch: config.branch, pollMinutes: config.pollMinutes, webPort: config.webPort },
    healthIntervalMs: 10_000,
    checkOnBoot: true,
  }, { port: config.port });
  void web.checkHealth();
  void host.checkHealth();
  console.log(`self-update: http://127.0.0.1:${running.port}/ (checkout ${config.checkout}, web port ${config.webPort})`);

  /* The prototype's own exit leaves the web process and the runtime host
     running (the next start adopts them by their records); it stops only an
     update command it started itself. */
  const shutdown = () => {
    ports.abort();
    running.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (import.meta.main) await main();
