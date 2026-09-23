/* #1254: the concrete ports for the runtime-host rehearsal, and its entry
   point. Run directly, this file is the rehearsal:

     bun run src/runtime-host/hostRehearsalRun.ts

   It starts two real runtime-host generations under a chosen Bun, drives one
   singleton-fence succession between them, and holds the stable listener the
   succession handed over. Everything it touches is created here and removed
   here: a private state directory, a private socket, an ephemeral loopback
   port. It never reads the operator's state directory and never binds 8898.

   The succession is a rollback across the two Docker spellings
   (docs/design/rename-delegatus.md §6.6). The first generation is a release
   that switched to the `delegatus` names; it boots, completes the handoff from
   the generation before it and records that one as its rollback target. The
   second is that retained generation, this release, started from an
   `agent-log-viewer:*` image the way `scripts/rollback-runtime-host.ts` starts
   it: it has to find the failed generation, stop it, take the fence and remove
   it. Both generations reach Docker only through a stub on their PATH, which
   records each call and touches no daemon. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type {
  RuntimeHostGenerationIdentity,
  ViewerRuntimeHostHealthEvidence,
  ViewerRuntimeHostRecoveryEvidence,
} from "@/lib/runtime/contracts";

import {
  RUNTIME_HOST_REHEARSAL_LOG_LINES,
  RUNTIME_HOST_REHEARSAL_REPORT_PREFIX,
  rehearseRuntimeHost,
  type RuntimeHostRehearsalGeneration,
  type RuntimeHostRehearsalPorts,
} from "./hostRehearsal";
import { DELEGATUS_DOCKER_NAMES, LEGACY_DOCKER_NAMES, type DockerNameSpelling } from "./dockerNames";
import { RUNTIME_HOST_FENCE_WAIT_ENV } from "./fenceWait";
import {
  readRuntimeHostRelease,
  readRuntimeHostRollbackTarget,
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  writeRuntimeHostHandoffIntent,
  writeRuntimeHostRelease,
  writeRuntimeHostRollbackIntent,
  type RuntimeHostReleaseRecord,
  type RuntimeHostRollbackTarget,
} from "./hostRelease";
import { requestRuntimeHostRollback } from "./hostRollback";
import { runtimeHostSuccessorName } from "./hostSuccessor";

/** The successor's own fence wait has to outlast the succession budget, or it
    fails its container before the predecessor has finished releasing. */
const REHEARSAL_FENCE_WAIT_MS = 120_000;
/** A probe that waits longer than this against a local endpoint is a failure,
    not a slow answer. */
const PROBE_TIMEOUT_MS = 5_000;
/* The seed, sized by what actually makes a write fail. A write only fails once
   the peer has gone while bytes are still pending in the host: an answer the
   kernel swallows whole is written before anyone can leave. Measured under Bun
   1.4.0 on a Unix socket, an answer of ~400 KB leaves nothing pending and one
   of ~600 KB does, so the seed builds a snapshot several times past that.
   The journal caps an event payload at 16 KiB, and a session's live turn is
   kept per session, so the size comes from the number of sessions. Sixty-four
   of them project to roughly two megabytes — the shape of a real snapshot,
   which is what `PreserializedJson` exists for. */
const SEED_SESSIONS = 64;
const SEED_LIVE_TURN_BYTES = 15_000;
/** A frame beyond this is a runaway answer, not a large one. */
const MAX_PROBE_FRAME_BYTES = 64 * 1024 * 1024;
/** How long an abandoning caller lets the answer accumulate unread before it
    vanishes. Long enough for the host to fill the socket buffer and still be
    writing; short enough that a hold window is made of real polls. */
const ABANDON_DELAY_MS = 150;

export interface RuntimeHostRehearsalRunOptions {
  /** The interpreter under test; `bun-container` inside the image. */
  runtimeBin: string;
  /** Repository (or `/app`) root that owns `src/runtime-host/main.ts`. */
  root: string;
  stateDir: string;
  port: number;
  holdWindowMs?: number;
}

/** Everything the rehearsal hands its generations, under its state directory. */
export function runtimeHostRehearsalFiles(stateDir: string) {
  return {
    release: path.join(stateDir, "runtime-host-release.json"),
    rollbackTarget: path.join(stateDir, "runtime-host-rollback-target.json"),
    rollbackIntent: path.join(stateDir, "runtime-host-rollback-intent.json"),
    handoffIntent: path.join(stateDir, "runtime-host-handoff-intent.json"),
    /** Ahead of everything else on the generations' PATH. */
    tools: path.join(stateDir, "bin"),
    dockerCalls: path.join(stateDir, "docker-calls.log"),
  };
}

function rehearsalRelease(names: DockerNameSpelling, revision: string, port: number, stagedAt: string): RuntimeHostReleaseRecord {
  const image = `${names.imageRepository}:rehearsal-${revision.slice(0, 12)}`;
  return {
    revision,
    image,
    container: runtimeHostSuccessorName(revision, image, names),
    endpoint: `http://127.0.0.1:${port}`,
    stagedAt,
  };
}

/** The two generations, one per spelling. `failed` serves first and is the
    release that switched names; `retained` is this release, which the
    rollback brings back. */
export function runtimeHostRehearsalGenerations(port: number, stagedAt = "2026-01-01T00:00:00.000Z"): {
  failed: RuntimeHostReleaseRecord;
  retained: RuntimeHostReleaseRecord;
} {
  return {
    failed: rehearsalRelease(DELEGATUS_DOCKER_NAMES, "d".repeat(40), port, stagedAt),
    retained: rehearsalRelease(LEGACY_DOCKER_NAMES, "a".repeat(40), port, stagedAt),
  };
}

export function runtimeHostRehearsalEnvironment(
  options: RuntimeHostRehearsalRunOptions,
  role: "predecessor" | "successor",
): Record<string, string | undefined> {
  const files = runtimeHostRehearsalFiles(options.stateDir);
  const { failed, retained } = runtimeHostRehearsalGenerations(options.port);
  const generation = role === "predecessor" ? failed : retained;
  const environment: Record<string, string | undefined> = {
    PATH: [files.tools, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(path.delimiter),
    // The environment is built rather than inherited, so the rehearsal cannot
    // pick up a live socket, journal or state dir from whoever started it.
    // The image pins production, and the host under test must see the same.
    HOME: options.stateDir,
    XDG_CONFIG_HOME: path.join(options.stateDir, "config"),
    TMPDIR: path.join(options.stateDir, "tmp"),
    LLV_STATE_DIR: options.stateDir,
    LLV_RUNTIME_HOST_SOCKET: path.join(options.stateDir, "runtime-host.sock"),
    LLV_RUNTIME_JOURNAL: path.join(options.stateDir, "runtime-events.sqlite"),
    /* The stable listener exists only when deployments are enabled, and the
       listener is the point. The adapter runs only the boot-time handoff
       completion: no deployment is requested, and the release target file is
       deliberately absent, so the proxy answers its own 503 — which is the
       raw-write path that took the host down, exercised on every probe. */
    LLV_VIEWER_DEPLOYMENTS: "1",
    LLV_VIEWER_DEPLOY_ADAPTER: path.join(options.root, "scripts", "runtime-host-viewer-adapter.ts"),
    LLV_VIEWER_DEPLOY_TARGET: path.join(options.stateDir, "viewer-release.json"),
    LLV_VIEWER_PORT: String(options.port),
    LLV_RUNTIME_HOST_RELEASE_TARGET: files.release,
    LLV_RUNTIME_HOST_ROLLBACK_TARGET: files.rollbackTarget,
    LLV_RUNTIME_HOST_ROLLBACK_INTENT_TARGET: files.rollbackIntent,
    LLV_RUNTIME_HOST_HANDOFF_INTENT_TARGET: files.handoffIntent,
    /* The identity dockerd injects into a managed generation. With the release
       record naming it, the host is a tracked generation and runs the handoff
       and rollback steps at boot. */
    [RUNTIME_HOST_IMAGE_ENV]: generation.image,
    [RUNTIME_HOST_REVISION_ENV]: generation.revision,
    [RUNTIME_HOST_CONTAINER_ENV]: generation.container,
    ...(role === "successor" ? { [RUNTIME_HOST_FENCE_WAIT_ENV]: String(REHEARSAL_FENCE_WAIT_MS) } : {}),
  };
  Reflect.deleteProperty(environment, "NODE_ENV");
  return environment;
}

function startGeneration(options: RuntimeHostRehearsalRunOptions, role: "predecessor" | "successor"): RuntimeHostRehearsalGeneration {
  const child: ChildProcess = spawn(options.runtimeBin, ["run", "src/runtime-host/main.ts"], {
    cwd: options.root,
    env: runtimeHostRehearsalEnvironment(options, role) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const collect = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      lines.push(`${role}: ${line}`);
      if (lines.length > RUNTIME_HOST_REHEARSAL_LOG_LINES) lines.shift();
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => collect(`failed to start: ${error.message}`));
  let exited = false;
  const gone = new Promise<void>((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  return {
    exited: () => exited,
    log: () => [...lines],
    stop: async () => {
      if (exited) return;
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { await gone; } finally { clearTimeout(forced); }
    },
  };
}

/**
 * One request against the stable listener. `abandon` drops the caller as soon
 * as the connection exists, leaving the host to write its answer into a socket
 * whose peer is gone — the production failure, produced on purpose rather than
 * waited for. Any HTTP status counts: the rehearsal asks whether the listener
 * is held, not what is behind it.
 */
export function probeStableListener(port: number, options: { abandon: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    const socket = net.createConnection(port, "127.0.0.1");
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("data", (chunk) => finish(String(chunk).startsWith("HTTP/1.")));
    socket.once("connect", () => {
      /* An abandoning caller vanishes the moment the connection exists — the
         listener is already composing its answer into a peer that is gone.
         Reaching `connect` is itself the evidence that the listener is held. */
      if (options.abandon) return finish(true);
      socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
  });
}

/**
 * One request on the runtime socket. `abandon` never reads a byte and then
 * vanishes, leaving the host with the rest of a multi-megabyte frame still
 * pending for a peer that is gone. That is the production write: Bun 1.3.3
 * dropped its failure, 1.4.0 reports it, and a host without a handler on that
 * connection dies of it — which this rehearsal, run against the host as it
 * was, reproduces.
 */
export function probeRuntimeSocket(socketPath: string, request: unknown, options: { abandon: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(abandonment);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    let abandonment: ReturnType<typeof setTimeout> | undefined;
    const socket = net.createConnection(socketPath);
    let frame = "";
    /* What an abandoning caller asks of the endpoint is that it take the
       request; the answer is what it deliberately walks away from. Once the
       request is on the wire the poll is answered however the connection then
       ends — under 1.3.3 the host drops the failing write and closes it
       itself, and that is the runtime behaving as it always did, not a
       listener that stopped answering. A host that is actually gone fails the
       next poll, which reads its answer in full. */
    let requested = false;
    socket.on("error", () => finish(requested));
    socket.on("close", () => finish(requested));
    if (!options.abandon) {
      socket.on("data", (chunk) => {
        // Reading to the frame delimiter is what a complete answer means here.
        frame += String(chunk);
        const newline = frame.indexOf("\n");
        if (newline >= 0) finish(frame.slice(0, newline).includes('"ok":true'));
        else if (frame.length > MAX_PROBE_FRAME_BYTES) finish(false);
      });
    }
    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
      if (!options.abandon) return;
      requested = true;
      /* An abandoning caller never reads a byte: with no `data` listener the
         socket stays paused, so the answer fills the socket buffer and the
         rest of it is still pending in the host when this caller vanishes.
         That pending remainder is the production write, and leaving one
         behind is why the seed above is sized the way it is. */
      abandonment = setTimeout(() => finish(true), ABANDON_DELAY_MS);
    });
  });
}

/** Fill the journal so one snapshot is a multi-megabyte answer. */
async function seedJournal(socketPath: string): Promise<void> {
  const text = "x".repeat(SEED_LIVE_TURN_BYTES);
  for (let index = 0; index < SEED_SESSIONS; index += 1) {
    const turnId = `rehearsal-turn-${index}`;
    const appended = await probeRuntimeSocket(socketPath, {
      id: `rehearsal-seed-${index}`,
      method: "append",
      params: {
        event: {
          scope: `session:rehearsal-${index}`,
          kind: "session-status",
          // A running turn is what keeps live text in the snapshot projection.
          payload: { host: "hosted", turn: "running", activeTurnId: turnId, liveTurn: { turnId, text } },
        },
      },
    }, { abandon: false });
    if (!appended) throw new Error("the runtime host refused the rehearsal seed");
  }
}

function executablePath(command: string): string | null {
  if (command.includes("/")) return path.resolve(command);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* not here */ }
  }
  return null;
}

/**
 * The tools a tracked generation reaches for at boot. `docker` is a stub that
 * appends each call to a log and answers an inspect with the id it was asked
 * about, so the rehearsal can never reach a daemon, least of all the
 * operator's. `bun-container` is the interpreter under test: the host runs
 * its deployment adapter as an executable whose `#!/usr/bin/env bun-container`
 * line names the image's own Bun, which a checkout outside the image lacks.
 */
function installRehearsalTools(options: RuntimeHostRehearsalRunOptions): void {
  const files = runtimeHostRehearsalFiles(options.stateDir);
  fs.mkdirSync(files.tools, { recursive: true, mode: 0o700 });
  const quotedLog = `'${files.dockerCalls.replaceAll("'", `'\\''`)}'`;
  fs.writeFileSync(path.join(files.tools, "docker"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${quotedLog}`,
    'if [ "$1" = container ] && [ "$2" = inspect ]; then',
    '  for target in "$@"; do :; done',
    `  printf '[{"Id":"%s","Name":"/%s"}]\\n' "$target" "$target"`,
    "fi",
    "",
  ].join("\n"), { mode: 0o755 });
  const runtime = executablePath(options.runtimeBin);
  const link = path.join(files.tools, "bun-container");
  if (runtime && runtime !== link) {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(runtime, link);
  }
}

function identity(release: RuntimeHostReleaseRecord): RuntimeHostGenerationIdentity {
  return { image: release.image, revision: release.revision, container: release.container };
}

function readLines(filename: string): string[] {
  try { return fs.readFileSync(filename, "utf8").split("\n").filter(Boolean); } catch { return []; }
}

/**
 * What the retained generation should have done, checked against what it did.
 * `null` when it found the rollback target the failed generation recorded,
 * stopped and removed that generation and nothing else, and cleared the
 * rollback it carried out.
 */
export function runtimeHostRecoveryFailure(input: {
  failed: RuntimeHostGenerationIdentity;
  retained: RuntimeHostGenerationIdentity;
  /** The rollback target the failed generation recorded, as the rollback read it. */
  found: RuntimeHostRollbackTarget | null;
  docker: string[];
  /** The durable release record once the hold is over. */
  release: RuntimeHostGenerationIdentity | null;
  rollbackIntentLeft: boolean;
  rollbackTargetLeft: boolean;
}): string | null {
  const { failed, retained, found } = input;
  if (!found) return `${failed.container} never recorded ${retained.container} as its rollback target`;
  if (found.active.container !== failed.container || found.previous.container !== retained.container) {
    return `the rollback target named ${found.active.container} → ${found.previous.container} instead of ${failed.container} → ${retained.container}`;
  }
  const target = (line: string) => line.split(" ").at(-1);
  const expected: Array<[string, string]> = [
    ["container inspect", failed.container],
    ["container update", failed.container],
    ["container stop", failed.container],
    ["container rm", failed.container],
  ];
  let next = 0;
  for (const line of input.docker) {
    const step = expected[next];
    if (step && line.startsWith(step[0]) && target(line) === step[1]) next += 1;
  }
  if (next < expected.length) {
    const [verb, container] = expected[next]!;
    return `no generation ran docker ${verb} … ${container} (it ran: ${input.docker.join("; ") || "nothing"})`;
  }
  const againstRetained = input.docker.find((line) => /^container (update|stop|rm|kill)\b/.test(line) && target(line) === retained.container);
  if (againstRetained) return `the rollback turned on the generation it kept: docker ${againstRetained}`;
  if (input.rollbackIntentLeft) return "the retained generation never cleared the rollback intent";
  if (input.rollbackTargetLeft) return "the retained generation never cleared the rollback target";
  if (input.release?.container !== retained.container) {
    return `the durable release record names ${input.release?.container ?? "nothing"} instead of ${retained.container}`;
  }
  return null;
}

export function runtimeHostRehearsalPorts(options: RuntimeHostRehearsalRunOptions): RuntimeHostRehearsalPorts {
  const socketPath = path.join(options.stateDir, "runtime-host.sock");
  const files = runtimeHostRehearsalFiles(options.stateDir);
  installRehearsalTools(options);
  const { failed, retained } = runtimeHostRehearsalGenerations(options.port, new Date().toISOString());
  let found: RuntimeHostRollbackTarget | null = null;
  return {
    start: async (role) => {
      if (role === "predecessor") {
        /* A handoff to the failed generation, as its predecessor staged it:
           it completes this at boot and keeps `retained` as its rollback target. */
        writeRuntimeHostRelease(failed, files.release);
        writeRuntimeHostHandoffIntent({
          revision: failed.revision,
          image: failed.image,
          successorContainer: failed.container,
          predecessorId: retained.container,
          previousRelease: retained,
          successorRelease: failed,
          recordedAt: failed.stagedAt,
        }, files.handoffIntent);
        return startGeneration(options, role);
      }
      /* The rollback, as `scripts/rollback-runtime-host.ts --execute` requests
         it, with starting the retained container standing in for dockerd. A
         target that is not there is reported by `recovery`. */
      try { found = readRuntimeHostRollbackTarget(files.rollbackTarget); } catch { found = null; }
      if (!found) return startGeneration(options, role);
      const started: { generation?: RuntimeHostRehearsalGeneration } = {};
      await requestRuntimeHostRollback(found, {
        writeIntent: (intent) => writeRuntimeHostRollbackIntent(intent, files.rollbackIntent),
        writeRelease: (release) => writeRuntimeHostRelease(release, files.release),
        enablePreviousRestart: async () => {},
        startPrevious: async () => { started.generation = startGeneration(options, role); },
      });
      return started.generation ?? startGeneration(options, role);
    },
    seed: () => seedJournal(socketPath),
    probeListener: (probe) => probeStableListener(options.port, probe),
    /* The snapshot, because it is the large answer: a peer that leaves during
       one of these is the write that took production down. */
    probeSocket: (probe) => probeRuntimeSocket(socketPath, { id: "rehearsal-snapshot", method: "snapshot", params: {} }, probe),
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    recovery: async () => {
      const evidence: ViewerRuntimeHostRecoveryEvidence = {
        retained: identity(retained),
        failed: identity(failed),
        docker: readLines(files.dockerCalls),
      };
      let release: RuntimeHostGenerationIdentity | null = null;
      try { release = readRuntimeHostRelease(files.release); } catch { release = null; }
      return {
        evidence,
        failure: runtimeHostRecoveryFailure({
          failed: evidence.failed,
          retained: evidence.retained,
          found,
          docker: evidence.docker,
          release,
          rollbackIntentLeft: fs.existsSync(files.rollbackIntent),
          rollbackTargetLeft: fs.existsSync(files.rollbackTarget),
        }),
      };
    },
  };
}

/** An unused loopback port, claimed and released so the host can bind it. */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no ephemeral port was assigned"));
      server.close(() => resolve(address.port));
    });
  });
}

async function runtimeVersion(runtimeBin: string): Promise<string> {
  const child = spawn(runtimeBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const version = output.trim();
  return code === 0 && version ? `bun ${version}` : `${path.basename(runtimeBin)} (version unavailable)`;
}

/**
 * Rehearse the runtime host once, under `runtimeBin`, in a state directory
 * created for this run and removed after it.
 */
export async function runRuntimeHostRehearsal(options: {
  runtimeBin?: string;
  root?: string;
  stateDir?: string;
  holdWindowMs?: number;
}): Promise<ViewerRuntimeHostHealthEvidence> {
  const runtimeBin = options.runtimeBin ?? process.env.LLV_RUNTIME_HOST_REHEARSAL_BIN ?? "bun";
  const root = options.root ?? process.cwd();
  const stateDir = options.stateDir
    ?? process.env.LLV_RUNTIME_HOST_REHEARSAL_STATE_DIR
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-rehearsal-"));
  fs.mkdirSync(path.join(stateDir, "tmp"), { recursive: true, mode: 0o700 });
  const owned = options.stateDir === undefined && process.env.LLV_RUNTIME_HOST_REHEARSAL_STATE_DIR === undefined;
  try {
    return await rehearseRuntimeHost(
      runtimeHostRehearsalPorts({ runtimeBin, root, stateDir, port: await ephemeralPort() }),
      {
        runtime: await runtimeVersion(runtimeBin),
        ...(options.holdWindowMs === undefined ? {} : { holdWindowMs: options.holdWindowMs }),
      },
    );
  } finally {
    if (owned) fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const report = await runRuntimeHostRehearsal({
    ...(process.env.LLV_RUNTIME_HOST_REHEARSAL_ROOT ? { root: process.env.LLV_RUNTIME_HOST_REHEARSAL_ROOT } : {}),
  });
  console.log(RUNTIME_HOST_REHEARSAL_REPORT_PREFIX + JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
