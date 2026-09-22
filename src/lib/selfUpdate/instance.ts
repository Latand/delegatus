/* The one self-update service of this web process, wired to the real
   install (#2007). Everything that resolves the state directory runs on the
   first request, never while a module loads (#1905). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runtimeHostClient } from "@/lib/runtime/client";
import { requestViewerDeployment } from "@/lib/runtime/deploymentRuntime";
import { stateDir, statePath } from "@/lib/configDir";
import { readHotStateReleaseTarget } from "@/lib/state/hotStateAuthority";

import { buildEnv } from "./env";
import { CANONICAL_REMOTE, checkForUpdate, readRevision, runGit } from "./git";
import { requestRestart } from "./launcher";
import { detectMode, productionModePorts } from "./mode";
import { sameProcess } from "./pid";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { realPorts, UpdateRunner } from "./steps";
import type { Snapshot } from "./types";

const POLL_MINUTES = 60;
const SSE_MIN_GAP_MS = 250;
const TICK_ACTIVE_MS = 1_000;
const TICK_IDLE_MS = 5_000;
const KEEPALIVE_MS = 15_000;

/** The bare repository the managed install checks against. Its object store
    borrows the deploy adapter's canonical mirror (read-only, through git's
    alternates) when that mirror exists, so a check fetches only what is new;
    nothing is ever written into the mirror. */
export async function prepareManagedCheckRepo(directory: string, mirrorObjects: string): Promise<string> {
  if (!existsSync(join(directory, "HEAD"))) {
    mkdirSync(directory, { recursive: true });
    const result = await runGit(["init", "--bare", "--quiet", directory], directory);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "git init failed");
  }
  const alternates = join(directory, "objects", "info", "alternates");
  if (existsSync(mirrorObjects)) {
    let current = "";
    try { current = readFileSync(alternates, "utf8").trim(); } catch { /* none yet */ }
    if (current !== mirrorObjects) {
      mkdirSync(join(directory, "objects", "info"), { recursive: true });
      writeFileSync(alternates, `${mirrorObjects}\n`);
    }
  }
  return directory;
}

export function productionDeps(env: Readonly<Record<string, string | undefined>> = process.env): ServiceDeps {
  const dir = statePath("self-update");
  const remote = env.LLV_SELF_UPDATE_REMOTE?.trim() || env.LLV_VIEWER_CANONICAL_REMOTE?.trim() || CANONICAL_REMOTE;
  const branch = env.LLV_SELF_UPDATE_BRANCH?.trim() || "main";
  const port = Number(env.PORT);
  return {
    now: () => Date.now(),
    env,
    dir,
    remote,
    branch,
    pollMinutes: POLL_MINUTES,
    bun: process.execPath,
    mode: () => detectMode(productionModePorts(runtimeHostClient(), env)),
    check: checkForUpdate,
    describe: readRevision,
    createRunner: (config, publish, onChange) => new UpdateRunner(config, realPorts(publish), onChange),
    requestRestart,
    processAlive: (pid, startIdentity) => sameProcess({ pid, startIdentity }),
    hostHealth: async () => {
      const client = runtimeHostClient();
      if (!client?.runtimeHostHealth) return null;
      return client.runtimeHostHealth();
    },
    requestDeployment: requestViewerDeployment,
    readDeployment: async (deploymentId) => {
      const client = runtimeHostClient();
      return client ? client.readViewerDeployment(deploymentId) : null;
    },
    releaseTarget: () => readHotStateReleaseTarget(stateDir()),
    prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), statePath("deployments", "canonical.git", "objects")),
    buildEnv: (scratch) => buildEnv(scratch),
    web: {
      pid: process.pid,
      port: Number.isInteger(port) && port > 0 ? port : null,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
  };
}

const KEY = Symbol.for("llv.selfUpdate.service");
type Holder = { [KEY]?: SelfUpdateService | null };

/* One instance per process, shared across the route bundles (each route is
   its own module graph in a production build). */
export function selfUpdateService(): SelfUpdateService {
  const holder = globalThis as Holder;
  if (!holder[KEY]) holder[KEY] = new SelfUpdateService(productionDeps());
  return holder[KEY]!;
}

/** Tests only; `null` drops the instance so the next call builds a fresh one. */
export function setSelfUpdateServiceForTests(service: SelfUpdateService | null): void {
  const holder = globalThis as Holder;
  holder[KEY]?.stop();
  holder[KEY] = service;
}

/** The Snapshot as a server-sent event stream: one `state` event on every
    change (at most one per 250 ms), and a re-read of the install every
    second while something runs and every five seconds otherwise, since the
    launcher, the runtime host and a deployment move without telling us. */
export function snapshotStream(service: SelfUpdateService, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let last = "";
  let pending: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setTimeout> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let off: () => void = () => {};
  let lastSent = 0;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    off();
    if (pending) clearTimeout(pending);
    if (tick) clearTimeout(tick);
    if (keepalive) clearInterval(keepalive);
    try { controllerRef?.close(); } catch { /* already closed */ }
  };
  const send = (text: string) => {
    if (closed) return;
    try { controllerRef?.enqueue(encoder.encode(text)); } catch { close(); }
  };
  const broadcast = async (force = false) => {
    pending = null;
    if (closed) return;
    let snapshot: Snapshot;
    try { snapshot = await service.snapshot(); } catch { return; }
    const body = JSON.stringify(snapshot);
    /* serverTime moves every read; compare without it. */
    const comparable = body.replace(/"serverTime":"[^"]*"/, "");
    if (!force && comparable === last) return;
    last = comparable;
    lastSent = Date.now();
    send(`event: state\ndata: ${body}\n\n`);
  };
  const schedule = () => {
    if (pending || closed) return;
    pending = setTimeout(() => { void broadcast(); }, Math.max(0, lastSent + SSE_MIN_GAP_MS - Date.now()));
  };
  const loop = () => {
    tick = setTimeout(() => {
      void broadcast().finally(() => { if (!closed) loop(); });
    }, service.active() ? TICK_ACTIVE_MS : TICK_IDLE_MS);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      send("retry: 2000\n\n");
      off = service.changes.on(schedule);
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      signal.addEventListener("abort", close, { once: true });
      void broadcast(true);
      loop();
    },
    cancel() { close(); },
  });
}
