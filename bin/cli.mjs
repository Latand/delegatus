#!/usr/bin/env node

/* FIRST: fold DELEGATUS_* into LLV_* before anything below reads the
   environment (docs/design/rename-delegatus.md §5). */
import "./envAlias.mjs";

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectTailscale,
  getToken,
  OPERATOR_HINT,
  OPERATOR_PATTERN,
  phoneAccessFlagPath,
  readPhoneAccessFlag,
  readStatus,
  serve as serveTailscale,
  serveBackground,
  TailscaleError,
} from "./tailscale.mjs";
import {
  browserOpenCommand,
  cliRuntimeHostConfig,
  cliRuntimeHostEnvironment,
  discardWakatimeEnvironmentCredential,
  newlyBoundNonLoopbackAddress,
  readNonLoopbackBindState,
  viewerChildProcessOptions,
  viewerServerBunRuntime,
} from "./server-runtime.mjs";
import {
  createLauncherRecord,
  exitError,
  hostEntrypoint,
  installedRelease,
  isGitCheckout,
  probePageAndChunk,
  selfUpdatePaths,
  watchRestartRequests,
} from "./self-update-supervisor.mjs";
import { findLegacySystemdUnits, legacySystemdNotice } from "./legacySystemd.mjs";

discardWakatimeEnvironmentCredential();

/* The launcher is one of the process kinds that may resolve the operator's own
   config and state directories (#1905); everything it starts inherits the
   claim, and the Viewer child below upgrades it to `viewer`. Set it before any
   state is read so the claim is never late. */
if (!process.env.LLV_STATE_OWNER) process.env.LLV_STATE_OWNER = "launcher";

const DEFAULT_PORT = 8898;
const DEFAULT_HOSTNAME = "127.0.0.1";
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_INTERVAL_MS = 200;
// Socket timeout for a single readiness probe. The probe hits /api/files,
// which scans every log under ~/.claude and ~/.codex; with a few hundred
// conversations that scan takes 250-600ms, well past the 200ms poll cadence.
// Reusing READINESS_INTERVAL_MS here made every probe abort before the healthy
// server could answer, so startup always "timed out" and killed its own server.
const READINESS_PROBE_TIMEOUT_MS = 5_000;
const RUNTIME_HOST_READINESS_TIMEOUT_MS = 15_000;
const RUNTIME_HOST_READINESS_INTERVAL_MS = 100;
const RUNTIME_HOST_RESTART_BASE_MS = 500;
const RUNTIME_HOST_RESTART_MAX_MS = 10_000;
const RUNTIME_HOST_STABLE_UPTIME_MS = 30_000;
/* A restart onto a freshly built release starts `next start` cold, which
   takes 10–30 s on a full checkout (#2007); the first start keeps its budget. */
const RESTART_READINESS_TIMEOUT_MS = 90_000;

const cliPath = fileURLToPath(import.meta.url);
const cliDir = dirname(cliPath);

/* Dependency-free CLI localization: English by default, Ukrainian when
   LLV_LANG=uk or the locale (LC_ALL/LANG) is a uk_* / uk.* variant. */
function detectLang() {
  const explicit = (process.env.LLV_LANG || "").toLowerCase();
  if (explicit === "uk" || explicit === "en") return explicit;
  const loc = (process.env.LC_ALL || process.env.LANG || "").toLowerCase();
  return loc === "uk" || loc.startsWith("uk_") || loc.startsWith("uk.") ? "uk" : "en";
}

const LANG = detectLang();

const MESSAGES = {
  en: {
    usage: () => `Usage: delegatus [options]

Options:
  -p, --port <n>       Port for the local server (default ${DEFAULT_PORT})
  -H, --hostname <h>   Bind address (default ${DEFAULT_HOSTNAME})
      --tailscale      Access over Tailscale
                       (also on while ${phoneAccessFlagPath()} exists; the
                       setup guide's phone step writes it)
      --no-open        Don't open the browser
      --new-token      Create a new access key
      --new-operator-token  Rotate the operator spawn capability
  -v, --version        Show the version
  -h, --help           Show this help`,
    badPort: (value) => `Invalid port: ${value}`,
    flagNeedsValue: (flag) => `Option ${flag} requires a value.`,
    hostnameNeedsValue: () => "Option --hostname requires a value.",
    unknownOption: (arg) => `Unknown option: ${arg}`,
    noPackageJson: () => "Couldn't find package.json for delegatus-cli.",
    readPackageJsonErr: (detail) => `Couldn't read package.json: ${detail}`,
    readPackageJsonErrGeneric: () => "Couldn't read package.json.",
    noServer: () => "No standalone server.js or local next found.",
    portBusy: (port) => `Port ${port} is busy. Try: bunx delegatus-cli --port ${port + 1}`,
    serverStartFail: (detail) => `Couldn't start the server: ${detail}`,
    serverTimeout: (seconds) => `The server didn't respond within ${seconds} seconds.`,
    bannerOpened: (url) => `  Opened:    ${url}`,
    bannerOpening: (url) => `  Opening:   ${url}`,
    bannerOpenUrl: (url) => `  Open ${url} in your browser.`,
    bannerReads: () => "  Reads logs from ~/.claude/projects, ~/.codex/sessions, ~/.copilot/session-state.",
    bannerDebug: () => "  DELEGATUS_DEBUG=1 — show startup diagnostics.",
    bannerStop: () => "  Ctrl+C — stop.  --tailscale — access from your phone.",
    tsLinkWarn: () => "  The link contains an access key — don't forward it to others.",
    tsCookie: () => "  After the first open the key is stored in a cookie for 30 days.",
    nonLocalWarn: () => "Warning: a non-local address exposes the viewer to the network, so access-key mode is forced on.",
    unexpectedNonLocalBind: (address) => `The server bound ${address} even though loopback was requested. Startup was stopped before the viewer could remain exposed.`,
    bindCheckFail: (detail) => `Couldn't verify the server bind: ${detail}. Startup was stopped.`,
    bindCheckSkipped: (addresses) => `Warning: the exposure check skipped addresses this machine would not answer for: ${addresses}.`,
    serverNotReady: () => "Server not ready.",
    runtimeHostEntryMissing: () => "The runtime host is missing from this install. Reinstall delegatus-cli and try again.",
    runtimeHostStartFail: (detail) => `Couldn't start the structured runtime host: ${detail}`,
    runtimeHostTimeout: (socketPath) => `the runtime host did not bind ${socketPath} within ${RUNTIME_HOST_READINESS_TIMEOUT_MS / 1_000} seconds; check the socket directory permissions`,
    runtimeHostExited: (detail) => `the runtime host exited before its socket was ready${detail ? `: ${detail}` : ""}`,
    runtimeHostOwnerMismatch: (ownerPid, childPid) => `the runtime host socket is owned by pid ${ownerPid}, while this CLI spawned pid ${childPid}; stop the other delegatus instance for this installation and try again`,
    runtimeHostRestart: (delay, detail) => `[runtime host] ${detail}; restarting in ${delay}ms`,
    runtimeHostRestartFail: (detail) => `[runtime host] restart failed: ${detail}`,
    phoneAccessSkipped: (detail) => `Phone access is turned on in the setup guide, and Tailscale is not ready, so this start is local only:\n${detail}`,
    phoneAccessUngated: (detail) => `Warning: the access key could not be read, so this start asks no key: ${detail}`,
    phoneServeFailed: (detail) => `Phone access is turned on in the setup guide, and publishing in the tailnet failed: ${detail}`,
  },
  uk: {
    usage: () => `Використання: delegatus [опції]

Опції:
  -p, --port <n>       Порт для локального сервера (типово ${DEFAULT_PORT})
  -H, --hostname <h>   Адреса прив'язки (типово ${DEFAULT_HOSTNAME})
      --tailscale      Доступ через Tailscale
                       (також увімкнено, поки існує ${phoneAccessFlagPath()};
                       його записує крок «Телефон» посібника з налаштування)
      --no-open        Не відкривати браузер
      --new-token      Створити новий ключ доступу
      --new-operator-token  Оновити операторський ключ запуску агентів
  -v, --version        Показати версію
  -h, --help           Показати довідку`,
    badPort: (value) => `Некоректний порт: ${value}`,
    flagNeedsValue: (flag) => `Опція ${flag} потребує значення.`,
    hostnameNeedsValue: () => "Опція --hostname потребує значення.",
    unknownOption: (arg) => `Невідома опція: ${arg}`,
    noPackageJson: () => "Не вдалося знайти package.json для delegatus-cli.",
    readPackageJsonErr: (detail) => `Не вдалося прочитати package.json: ${detail}`,
    readPackageJsonErrGeneric: () => "Не вдалося прочитати package.json.",
    noServer: () => "Не знайдено standalone server.js або локальний next.",
    portBusy: (port) => `Порт ${port} зайнятий. Спробуйте: bunx delegatus-cli --port ${port + 1}`,
    serverStartFail: (detail) => `Не вдалося запустити сервер: ${detail}`,
    serverTimeout: (seconds) => `Сервер не відповів за ${seconds} секунд.`,
    bannerOpened: (url) => `  Відкрито:  ${url}`,
    bannerOpening: (url) => `  Відкриваю: ${url}`,
    bannerOpenUrl: (url) => `  Відкрийте ${url} у браузері.`,
    bannerReads: () => "  Читає логи з ~/.claude/projects, ~/.codex/sessions, ~/.copilot/session-state.",
    bannerDebug: () => "  DELEGATUS_DEBUG=1 — показати діагностику запуску.",
    bannerStop: () => "  Ctrl+C — зупинити.  --tailscale — доступ з телефона.",
    tsLinkWarn: () => "  Посилання містить ключ доступу — не пересилайте його стороннім.",
    tsCookie: () => "  Після першого відкриття ключ зберігається у cookie на 30 днів.",
    nonLocalWarn: () => "Увага: нелокальна адреса відкриває viewer для мережі, тому режим ключа доступу увімкнено примусово.",
    unexpectedNonLocalBind: (address) => `Сервер прив'язався до ${address}, хоча було запитано локальну адресу. Запуск зупинено, щоб viewer не залишився відкритим у мережу.`,
    bindCheckFail: (detail) => `Не вдалося перевірити адресу сервера: ${detail}. Запуск зупинено.`,
    bindCheckSkipped: (addresses) => `Увага: перевірка на відкритість пропустила адреси, на які ця машина не відповідає: ${addresses}.`,
    serverNotReady: () => "Сервер не готовий.",
    runtimeHostEntryMissing: () => "У цьому пакеті немає runtime host. Перевстановіть delegatus-cli і повторіть спробу.",
    runtimeHostStartFail: (detail) => `Не вдалося запустити structured runtime host: ${detail}`,
    runtimeHostTimeout: (socketPath) => `runtime host не створив ${socketPath} за ${RUNTIME_HOST_READINESS_TIMEOUT_MS / 1_000} секунд; перевірте права каталогу сокета`,
    runtimeHostExited: (detail) => `runtime host завершився до готовності сокета${detail ? `: ${detail}` : ""}`,
    runtimeHostOwnerMismatch: (ownerPid, childPid) => `сокетом runtime host володіє процес ${ownerPid}, а цей CLI запустив процес ${childPid}; зупиніть інший delegatus для цієї інсталяції та повторіть спробу`,
    runtimeHostRestart: (delay, detail) => `[runtime host] ${detail}; повторний запуск за ${delay} мс`,
    runtimeHostRestartFail: (detail) => `[runtime host] помилка повторного запуску: ${detail}`,
    phoneAccessSkipped: (detail) => `Доступ із телефона увімкнено в посібнику з налаштування, але Tailscale не готовий, тому цей запуск лише локальний:\n${detail}`,
    phoneAccessUngated: (detail) => `Увага: не вдалося прочитати ключ доступу, тому цей запуск не питає ключа: ${detail}`,
    phoneServeFailed: (detail) => `Доступ із телефона увімкнено в посібнику з налаштування, але опублікувати в tailnet не вдалося: ${detail}`,
  },
};

const m = MESSAGES[LANG];

/* A newcomer's terminal shows the banner and the URL first (#2168). What the
   children write before the banner is held and follows it, and Next's own
   startup lines (its version, "Local:", "Ready in") are dropped: the banner
   names the URL that works, with the key when one gates the start.
   DELEGATUS_DEBUG=1 keeps Next's lines, and it is also what lets the children
   print their startup diagnostics (`src/lib/startupDiagnostics.ts`). An error
   is never dropped: it waits for the banner, or for the launcher to fail. */
const NEXT_STARTUP_LINE = /^\s*(?:▲ Next\.js |- (?:Local|Network|Environments|Experiments):|✓ (?:Starting|Ready in|Running next\.config))/;
const HELD_OUTPUT_LIMIT_BYTES = 1024 * 1024;
/* The name `src/lib/startupDiagnostics.ts` reads. */
const QUIET_DIAGNOSTICS_ENV = "LLV_QUIET_DIAGNOSTICS";

function withoutNextStartupLines(text) {
  return text
    .split("\n")
    .filter((line) => !NEXT_STARTUP_LINE.test(line.replace(/\x1b\[[0-9;]*m/g, "")))
    .join("\n");
}

function createStartupOutput() {
  const held = [];
  let heldBytes = 0;
  let released = false;
  let debug = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const [stream, text] of held.splice(0)) stream.write(text);
  };
  return {
    setDebug(value) {
      debug = value;
    },
    write(stream, chunk) {
      const text = debug ? String(chunk) : withoutNextStartupLines(String(chunk));
      if (!text) return;
      if (released) {
        stream.write(text);
        return;
      }
      held.push([stream, text]);
      heldBytes += text.length;
      if (heldBytes > HELD_OUTPUT_LIMIT_BYTES) release();
    },
    release,
  };
}

const startupOutput = createStartupOutput();
process.once("exit", () => startupOutput.release());

function usage() {
  return m.usage();
}

function fail(message) {
  startupOutput.release();
  console.error(message);
  process.exit(1);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(m.badPort(value));
  }
  return port;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    fail(m.flagNeedsValue(flag));
  }
  return value;
}

function parseArgs(args) {
  const options = {
    port: DEFAULT_PORT,
    hostname: DEFAULT_HOSTNAME,
    tailscale: false,
    noOpen: false,
    newToken: false,
    newOperatorToken: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-p" || arg === "--port") {
      const value = requireValue(args, index, arg);
      options.port = parsePort(value);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "-H" || arg === "--hostname") {
      options.hostname = requireValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--hostname=")) {
      const value = arg.slice("--hostname=".length);
      if (!value) {
        fail(m.hostnameNeedsValue());
      }
      options.hostname = value;
    } else if (arg === "--tailscale") {
      options.tailscale = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--new-token") {
      options.newToken = true;
    } else if (arg === "--new-operator-token") {
      options.newOperatorToken = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      fail(m.unknownOption(arg));
    }
  }

  return options;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function findPackageRoot(startDir) {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      fail(m.noPackageJson());
    }
    currentDir = parentDir;
  }
}

function readPackageJson(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    fail(
      error instanceof Error
        ? m.readPackageJsonErr(error.message)
        : m.readPackageJsonErrGeneric(),
    );
  }
}

function resolveServer(packageRoot, hostname) {
  const bunRuntime = viewerServerBunRuntime();
  const commandFor = (command, args, bunEntry = command, bunArgs = args) => bunRuntime
    ? { command: bunRuntime, args: ["--bun", bunEntry, ...bunArgs] }
    : { command, args };
  const publishedStandalone = join(packageRoot, "dist", "standalone", "server.js");
  if (existsSync(publishedStandalone)) {
    const launch = commandFor(process.execPath, [publishedStandalone], publishedStandalone, []);
    return {
      ...launch,
      cwd: join(packageRoot, "dist", "standalone"),
      label: "server.js",
    };
  }

  const repoStandalone = join(packageRoot, ".next", "standalone", "server.js");
  if (existsSync(repoStandalone)) {
    const launch = commandFor(process.execPath, [repoStandalone], repoStandalone, []);
    return {
      ...launch,
      cwd: join(packageRoot, ".next", "standalone"),
      label: "server.js",
    };
  }

  /* `node_modules/.bin/next` is a shell shim, and on Windows the installer
     writes `next.cmd` / `next.ps1` / `next.exe` instead of an extension-less
     file — so this probe found nothing there and a checkout could not start at
     all. Next's own entry point is an ordinary JavaScript file on every
     platform, and it is what the Bun runtime below actually runs. */
  const nextBin = [
    join(packageRoot, "node_modules", ".bin", "next"),
    join(packageRoot, "node_modules", "next", "dist", "bin", "next"),
  ].find((candidate) => existsSync(candidate));
  if (!nextBin) {
    fail(m.noServer());
  }

  return {
    ...commandFor(nextBin, ["start", "--hostname", hostname]),
    cwd: packageRoot,
    label: "next start",
  };
}

function buildChildEnv(options, runtime, packageRoot, runtimeHostEnvironment, extraEnv = {}) {
  const env = {
    ...runtimeHostEnvironment,
    ...extraEnv,
    /* This child IS the serving Viewer: it alone may run the state-mutating
       startup steps (imports, migrations, backups) that #1905 fenced off. */
    LLV_STATE_OWNER: "viewer",
    PORT: String(options.port),
    // zsh exports HOSTNAME with the machine name on this user's machine; setting it here keeps standalone bound to the requested address.
    HOSTNAME: options.hostname,
  };

  // The standalone server runs with cwd inside dist/standalone, so the
  // Telegram connector assets (issue #1059) are pinned to the package root
  // explicitly; a pre-set override always wins.
  const telegramVendor = join(packageRoot, "vendor", "telegram-mcp");
  if (!env.LLV_TELEGRAM_VENDOR_DIR && existsSync(telegramVendor)) {
    env.LLV_TELEGRAM_VENDOR_DIR = telegramVendor;
  }
  const telegramBridge = join(packageRoot, "bin", "telegram-login-bridge.py");
  if (!env.LLV_TELEGRAM_BRIDGE && existsSync(telegramBridge)) {
    env.LLV_TELEGRAM_BRIDGE = telegramBridge;
  }
  const telegramServerBridge = join(packageRoot, "bin", "telegram-mcp-server.py");
  if (!env.LLV_TELEGRAM_SERVER_BRIDGE && existsSync(telegramServerBridge)) {
    env.LLV_TELEGRAM_SERVER_BRIDGE = telegramServerBridge;
  }
  const telegramSessionReader = join(packageRoot, "bin", "telegram-session-reader.mjs");
  if (!env.LLV_TELEGRAM_SESSION_READER && existsSync(telegramSessionReader)) {
    env.LLV_TELEGRAM_SESSION_READER = telegramSessionReader;
  }
  const telegramProvisioner = join(packageRoot, "bin", "provision-telegram-connector.mjs");
  if (!env.LLV_TELEGRAM_PROVISIONER && existsSync(telegramProvisioner)) {
    env.LLV_TELEGRAM_PROVISIONER = telegramProvisioner;
  }

  /* A local-only start never advertises a tailnet link it inherited from the
     shell that launched it. */
  if (runtime.tailnetSkipped) {
    delete env.LLV_TOKEN;
    delete env.LLV_TS_HOST;
    delete env.LLV_TS_URL;
  }

  if (runtime.llvToken) {
    env.LLV_TOKEN = runtime.llvToken;
  }

  if (runtime.llvTsHost) {
    env.LLV_TS_HOST = runtime.llvTsHost;
  }

  if (runtime.tailnetUrl) {
    env.LLV_TS_URL = runtime.tailnetUrl;
  }

  if (options.newOperatorToken) {
    env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY = "1";
  }

  return env;
}

/* `launch.restarting` marks a web process started by a self-update restart
   (#2007): until it is ready, its exit is the restart's failure to handle,
   never a reason to stop the whole launcher. */
function startServer(server, options, runtime, tailscaleProcessRef, runtimeHostSupervisor, packageRoot, runtimeHostEnvironment, launch = {}) {
  const child = spawn(server.command, server.args, viewerChildProcessOptions({
    cwd: server.cwd,
    env: buildChildEnv(options, runtime, packageRoot, runtimeHostEnvironment, launch.extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  }));

  const state = {
    sawAddressInUse: false,
    stopping: false,
    restarting: launch.restarting === true,
  };

  /* Attached first, so a failed spawn is always reported by it (#2178). */
  child.on("error", (error) => {
    state.stopping = true;
    void Promise.all([
      tailscaleProcessRef?.current ? stopChild(tailscaleProcessRef.current) : Promise.resolve(),
      runtimeHostSupervisor.stop(),
    ]).finally(() => fail(m.serverStartFail(error.message)));
  });

  /* A child that could not be spawned may have no stdio streams at all. */
  child.stdout?.on("data", (chunk) => startupOutput.write(process.stdout, chunk));
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (text.includes("EADDRINUSE")) {
      state.sawAddressInUse = true;
      console.error(m.portBusy(options.port));
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      return;
    }

    startupOutput.write(process.stderr, chunk);
  });

  child.on("exit", async (code, signal) => {
    if (state.stopping || state.restarting) {
      return;
    }
    launch.onUnexpectedExit?.(child);

    // The server dying on its own (crash, EADDRINUSE) still leaves `tailscale
    // serve` running as our child; stop it through the bounded path (SIGTERM,
    // 2s, SIGKILL) so an unexpected server exit does not orphan the tailnet
    // mapping even when serve ignores SIGTERM.
    if (tailscaleProcessRef?.current) {
      await stopChild(tailscaleProcessRef.current);
    }
    await runtimeHostSupervisor.stop();

    if (state.sawAddressInUse) {
      process.exit(1);
    }

    if (signal) {
      process.exit(0);
    }

    process.exit(code ?? 1);
  });

  return { child, state };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function probeRuntimeHost(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

function runtimeHostFenceOwner(fencePath) {
  try {
    const owner = JSON.parse(readFileSync(fencePath, "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1) return null;
    if (typeof owner.startIdentity !== "string" || !owner.startIdentity.startsWith(`${owner.pid}:`)) return null;
    if (typeof owner.acquisitionId !== "string" || owner.acquisitionId.length < 16) return null;
    return owner;
  } catch {
    return null;
  }
}

function runtimeHostExitDetail(processHandle) {
  const { child, state } = processHandle;
  if (state.spawnError) {
    return state.spawnError.code === "ENOENT"
      ? `Bun executable ${state.command} is unavailable (${state.spawnError.message})`
      : `Bun could not launch the host (${state.spawnError.message})`;
  }
  const outcome = child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode ?? "unknown"}`;
  const stderr = state.stderrTail
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  return stderr ? `${outcome}: ${stderr}` : outcome;
}

/* The fence is a separate name from the endpoint because a Windows endpoint is
   a named pipe with no file to sit beside — see `cliRuntimeHostEndpoint`. */
async function waitForRuntimeHost(socketPath, fencePath, processHandle = null) {
  const deadline = Date.now() + RUNTIME_HOST_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processHandle?.state.spawnError) {
      throw new Error(runtimeHostExitDetail(processHandle));
    }
    if (processHandle && (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null)) {
      throw new Error(m.runtimeHostExited(runtimeHostExitDetail(processHandle)));
    }
    if (await probeRuntimeHost(socketPath)) {
      const owner = runtimeHostFenceOwner(fencePath);
      if (!processHandle) return;
      if (owner?.pid === processHandle.child.pid) return;
      if (owner) throw new Error(m.runtimeHostOwnerMismatch(owner.pid, processHandle.child.pid));
    }
    await wait(RUNTIME_HOST_READINESS_INTERVAL_MS);
  }
  throw new Error(m.runtimeHostTimeout(socketPath));
}

/* `hooks.release()` names the release each launch runs from (#2007): the
   installed self-update release, or the package root. The other hooks report
   to the self-update record; none of them decides anything. */
function createRuntimeHostSupervisor(config, bunRuntime, environment, packageRoot, hooks = {}) {
  let current = null;
  let currentRelease = null;
  let restartTimer = null;
  let restartFailures = 0;
  let stopping = false;
  const releaseFor = () => hooks.release?.() ?? { dir: packageRoot, sha: null };

  /* `release`, when given, is the release the retries start (a self-update
     restart whose new and previous releases both failed retries the previous
     one); otherwise each retry reads the installed release. */
  const scheduleRestart = (detail, uptimeMs = 0, release = null) => {
    if (stopping || restartTimer) return;
    restartFailures = uptimeMs >= RUNTIME_HOST_STABLE_UPTIME_MS ? 1 : restartFailures + 1;
    const delay = Math.min(
      RUNTIME_HOST_RESTART_BASE_MS * (2 ** Math.max(0, restartFailures - 1)),
      RUNTIME_HOST_RESTART_MAX_MS,
    );
    console.error(m.runtimeHostRestart(delay, detail));
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void launch(false, release ?? undefined).catch((error) => {
        if (stopping) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(m.runtimeHostRestartFail(message));
        scheduleRestart(message, 0, release);
      });
    }, delay);
  };

  const spawnHost = (release) => {
    const packaged = release.dir === packageRoot;
    const child = spawn(bunRuntime, ["--bun", packaged ? config.entrypoint : hostEntrypoint(release.dir)], viewerChildProcessOptions({
      cwd: release.dir,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    const state = {
      command: bunRuntime,
      readyAt: null,
      spawnedAt: Date.now(),
      spawnError: null,
      stderrTail: "",
      stopping: false,
    };
    /* Before anything else touches the child: a missing Bun is reported as an
       `error` event, and nothing here may throw ahead of the listener that
       turns it into the prerequisite message (#2178). */
    child.once("error", (error) => {
      state.spawnError = error;
    });
    const processHandle = { child, state };
    current = processHandle;
    currentRelease = release;
    hooks.onStarted?.(child, release);
    /* A child that could not be spawned may have no stdio streams at all. */
    child.stdout?.on("data", (chunk) => startupOutput.write(process.stdout, chunk));
    child.stderr?.on("data", (chunk) => {
      state.stderrTail = `${state.stderrTail}${chunk}`.slice(-8_192);
      startupOutput.write(process.stderr, chunk);
    });
    child.once("exit", () => {
      if (current !== processHandle || stopping || state.stopping || state.readyAt === null) return;
      hooks.onExit?.(child, state.spawnedAt);
      scheduleRestart(runtimeHostExitDetail(processHandle), Date.now() - state.readyAt);
    });
    return processHandle;
  };

  const launch = async (initial, release = releaseFor()) => {
    const processHandle = spawnHost(release);
    try {
      await waitForRuntimeHost(config.socketPath, config.fencePath, processHandle);
      processHandle.state.readyAt = Date.now();
      if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
        throw new Error(m.runtimeHostExited(runtimeHostExitDetail(processHandle)));
      }
      hooks.onReady?.(processHandle.child);
    } catch (error) {
      /* A host that ended on its own is reported with its exit; one this
         supervisor had to stop (no socket in time, another fence owner) with
         the reason it was stopped. Either way it is failed, never left
         reading as "starting" under a PID that is gone. */
      const exitedOnItsOwn = processHandle.child.exitCode !== null || processHandle.child.signalCode !== null;
      await stopChild(processHandle);
      hooks.onLaunchFailed?.(processHandle.child, processHandle.state.spawnedAt, exitedOnItsOwn, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    async start() {
      if (!existsSync(config.entrypoint)) throw new Error(m.runtimeHostEntryMissing());
      await launch(true);
    },
    async stop() {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (current) await stopChild(current);
    },
    /* A restart the operator asked for from the Update surface (#2007): stop
       the host this supervisor started, start it from the installed release,
       and when that one does not become ready, start the release it replaced.
       When that fails too, the crash backoff takes over and keeps starting
       the previous release, as it does for a host that dies on its own, and
       the restart rejects so the record says it failed. Resolves with the
       release that failed and why when the fallback ran, else null. */
    async restart() {
      if (stopping) return null;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const previous = current;
      const previousRelease = currentRelease ?? { dir: packageRoot, sha: null };
      if (previous) {
        hooks.onStopping?.();
        await stopChild(previous);
      }
      const attempted = releaseFor();
      try {
        await launch(false, attempted);
        restartFailures = 0;
        return null;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          await launch(false, previousRelease);
        } catch (fallbackError) {
          const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          scheduleRestart(`${detail}; the previous release did not start either: ${fallbackDetail}`, 0, previousRelease);
          throw fallbackError;
        }
        return { sha: attempted.sha, detail };
      }
    },
  };
}

function probe(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("error", () => {
      resolve(false);
    });

    request.setTimeout(READINESS_PROBE_TIMEOUT_MS, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function portAlreadyResponds(port) {
  return probe(`http://127.0.0.1:${port}/api/files`);
}

/* `processHandle`, when given, is the child the readiness belongs to: its exit
   ends the wait at once, since a port answered by anyone else is no proof. */
async function waitForReadiness(port, timeoutMs = READINESS_TIMEOUT_MS, processHandle = null) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/files`;

  while (Date.now() < deadline) {
    if (processHandle && (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null)) {
      throw new Error(`exited before it answered (${processHandle.child.signalCode ? `signal ${processHandle.child.signalCode}` : `exit code ${processHandle.child.exitCode}`})`);
    }
    if (await probe(url)) {
      return;
    }

    await wait(READINESS_INTERVAL_MS);
  }

  throw new Error(m.serverTimeout(timeoutMs / 1000));
}

/* The key rides in the local link too when this start gates on one: the
   Viewer asks every connection for it, loopback included, and the terminal
   that started it is the one place the operator can read it. */
function localUrl(options, runtime) {
  const host = options.hostname === "::1" ? "[::1]" : options.hostname;
  const key = runtime?.llvToken ? `?k=${runtime.llvToken}` : "";
  return `http://${host}:${options.port}/${key}`;
}

/* `browser` is what `openBrowser` found out: the banner says "Opened" only
   when an opener reported success. */
function printBanner(version, options, runtime, browser, debug) {
  const url = localUrl(options, runtime);
  console.log(`  ✳ Delegatus v${version}`);
  console.log(browser === "opened" ? m.bannerOpened(url) : browser === "opening" ? m.bannerOpening(url) : m.bannerOpenUrl(url));
  console.log(m.bannerReads());
  console.log(m.bannerStop());
  if (!debug) console.log(m.bannerDebug());
}

async function printTailscaleBanner(runtime) {
  if (!runtime.tailnetUrl) {
    return;
  }

  console.log(`  Tailnet:   ${runtime.tailnetUrl}`);
  const qrcodeModule = await import("qrcode-terminal");
  const qrcode = qrcodeModule.default ?? qrcodeModule;
  await new Promise((resolve) => {
    qrcode.generate(runtime.tailnetUrl, { small: true }, (qr) => {
      console.log(qr);
      resolve();
    });
  });
  console.log(m.tsLinkWarn());
  console.log(m.tsCookie());
}

const BROWSER_OPEN_WAIT_MS = 1_500;

/* "opened" when the opener exited 0, "failed" when it could not run or exited
   otherwise (xdg-open with no display), "opening" when it is still running
   after a moment, as an opener that starts the browser itself does. */
function openBrowser(url) {
  const opener = browserOpenCommand(url);
  if (!opener) {
    return Promise.resolve("failed");
  }

  return new Promise((resolve) => {
    /* `windowsHide` keeps the console rundll32 would otherwise flash on the
       desktop; it is inert on every other platform. */
    const child = spawn(opener.command, opener.args, viewerChildProcessOptions({
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    }));
    const timer = setTimeout(() => resolve("opening"), BROWSER_OPEN_WAIT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("failed");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "opened" : "failed");
    });
    child.unref();
  });
}

async function stopChild(processHandle) {
  const { child, state } = processHandle;
  state.stopping = true;

  // A failed spawn with no PID created no child to signal or wait for. Node
  // does not guarantee an exit event after a spawn error.
  if (state.spawnError && child.pid === undefined) return;

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
}

async function stopAll(serverProcess, tailscaleProcess, runtimeHostSupervisor) {
  await Promise.all([
    serverProcess ? stopChild(serverProcess) : Promise.resolve(),
    tailscaleProcess ? stopChild(tailscaleProcess) : Promise.resolve(),
    runtimeHostSupervisor ? runtimeHostSupervisor.stop() : Promise.resolve(),
  ]);
}

/* `serverRef.current` is whichever web process runs at shutdown: a
   self-update restart (#2007) replaces the one startup launched. */
function installSignalHandlers(serverRef, tailscaleProcessRef, runtimeHostSupervisor, onShutdown = () => {}) {
  const shutdown = async () => {
    onShutdown();
    await stopAll(serverRef.current, tailscaleProcessRef.current, runtimeHostSupervisor);
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function prepareRuntime(options) {
  const runtime = {
    llvToken: undefined,
    llvTsHost: undefined,
    tailnetUrl: undefined,
    tailscalePath: undefined,
    /* Set when the remembered choice fell back to a local start. */
    tailnetSkipped: false,
  };

  const nonLoopbackBind = !isLoopbackHostname(options.hostname);
  if (nonLoopbackBind) {
    console.error(m.nonLocalWarn());
  }

  if (options.tailscale) {
    let tailscalePath;
    let status;
    try {
      tailscalePath = await detectTailscale();
      status = await readStatus(tailscalePath);
    } catch (error) {
      /* The remembered choice never stops the Viewer from starting: a
         Tailscale that went away since starts locally, and says why. */
      if (!(options.tailscaleFromFlag && error instanceof TailscaleError)) throw error;
      console.error(m.phoneAccessSkipped(error.message));
      options.tailscale = false;
      options.tailscaleFromFlag = false;
      runtime.tailnetSkipped = true;
      /* The gate still goes on. A background mapping a previous tailnet start
         published belongs to tailscaled, not to this process: it resumes when
         tailscaled comes back, and it would otherwise proxy the whole tailnet
         into a Viewer that asks for nothing. The link itself stays unset, so
         nothing advertises an address this start does not serve. */
      try {
        const { token } = await getToken({ rotate: options.newToken });
        runtime.llvToken = token;
      } catch (tokenError) {
        console.error(m.phoneAccessUngated(tokenError instanceof Error ? tokenError.message : String(tokenError)));
      }
      return runtime;
    }
    const { token } = await getToken({ rotate: options.newToken });
    runtime.llvToken = token;
    runtime.llvTsHost = status.dnsName;
    runtime.tailnetUrl = `https://${status.dnsName}/?k=${token}`;
    runtime.tailscalePath = tailscalePath;
    options.hostname = DEFAULT_HOSTNAME;
    return runtime;
  }

  if (nonLoopbackBind) {
    const { token } = await getToken({ rotate: options.newToken });
    runtime.llvToken = token;
  }

  return runtime;
}

/* Symlink every skill this repo ships (.claude/skills/*) into each installed
   agent's global skills dir, so one `git pull` propagates the skills to Claude
   and Codex at once — no per-agent copy to keep in sync. Only runs from a real
   git checkout (the persistent source), never from a transient npm/bunx install.
   Idempotent; a pre-existing real copy is backed up once (<name>.bak) before it
   is replaced with the link. Best-effort — never blocks startup. */
function linkSkills(packageRoot) {
  if (!existsSync(join(packageRoot, ".git"))) return; // not a checkout → skip
  const source = join(packageRoot, ".claude", "skills");
  let skills;
  try {
    skills = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return;
  }
  if (skills.length === 0) return;
  const roots = [join(homedir(), ".claude", "skills"), join(homedir(), ".codex", "skills")];
  for (const root of roots) {
    if (!existsSync(dirname(root))) continue; // that agent isn't installed
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      continue;
    }
    for (const skill of skills) {
      const src = join(source, skill.name);
      const dest = join(root, skill.name);
      try {
        const stat = lstatSync(dest);
        if (stat.isSymbolicLink()) {
          try {
            if (realpathSync(dest) === realpathSync(src)) continue; // already linked here
          } catch {
            /* dangling link → relink below */
          }
          rmSync(dest);
        } else {
          /* Back up a pre-existing real copy into a hidden sibling dir so the
             skill loader (which scans visible subdirs for SKILL.md) never picks
             the backup up as a duplicate skill. */
          const backupDir = join(root, ".skill-backups");
          const backup = join(backupDir, skill.name);
          try {
            mkdirSync(backupDir, { recursive: true });
          } catch {
            /* fall through */
          }
          if (existsSync(backup)) rmSync(dest, { recursive: true, force: true });
          else renameSync(dest, backup);
        }
      } catch {
        /* dest is absent — fall through and create the link */
      }
      try {
        symlinkSync(src, dest, "dir");
      } catch {
        /* non-fatal: a single skill failing to link must not break launch */
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  /* Phone access turned on from the setup guide is remembered as a file; its
     presence stands for --tailscale. */
  if (!options.tailscale && !options.help && !options.version && await readPhoneAccessFlag()) {
    options.tailscale = true;
    options.tailscaleFromFlag = true;
  }
  const packageRoot = findPackageRoot(cliDir);
  try {
    linkSkills(packageRoot);
  } catch {
    /* skill linking is best-effort — never block the viewer from starting */
  }
  const packageJson = readPackageJson(packageRoot);
  const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.version) {
    console.log(version);
    return;
  }

  /* Everything started below inherits the choice (#2168). */
  const debug = process.env.LLV_DEBUG === "1";
  startupOutput.setDebug(debug);
  if (debug) delete process.env[QUIET_DIAGNOSTICS_ENV];
  else process.env[QUIET_DIAGNOSTICS_ENV] = "1";

  /* Before anything can fail on a port the old unit still holds. */
  const legacyNotice = legacySystemdNotice(findLegacySystemdUnits(), LANG);
  if (legacyNotice) console.error(`${legacyNotice}\n`);

  let runtime;
  try {
    runtime = await prepareRuntime(options);
  } catch (error) {
    if (error instanceof TailscaleError) {
      fail(error.message);
    }
    throw error;
  }

  if (await portAlreadyResponds(options.port)) {
    console.error(m.portBusy(options.port));
    process.exit(1);
  }

  // Snapshot who holds each non-loopback address before the Viewer exists, so
  // the post-readiness guard can only attribute a NEWLY bound one to it. An
  // address this machine will not answer for is recorded as unevaluated and
  // carried; only an unreadable interface list leaves the guard blind enough
  // to stop here.
  let bindStateBeforeLaunch = { occupied: new Set(), free: new Set(), unevaluated: new Map() };
  if (isLoopbackHostname(options.hostname)) {
    try {
      bindStateBeforeLaunch = await readNonLoopbackBindState(options.port);
    } catch (error) {
      fail(m.bindCheckFail(error instanceof Error ? error.message : String(error)));
    }
  }

  const runtimeHostConfig = cliRuntimeHostConfig(packageRoot);
  const runtimeHostEnvironment = cliRuntimeHostEnvironment(process.env, runtimeHostConfig);

  /* Self-update (#2007). A git checkout starts each child from the release
     the Viewer's Update surface last published (or from the package root),
     records what it started, and restarts one child when the surface asks.
     A packaged install records its children too, and the surface reads the
     record's missing checkout as "updates come from the package manager". */
  const checkout = isGitCheckout(packageRoot);
  const selfUpdate = selfUpdatePaths({
    stateDirectory: runtimeHostConfig.stateDirectory,
    cacheDirectory: process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
    installId: runtimeHostConfig.installId,
  });
  const releaseNow = () => (checkout
    ? installedRelease(selfUpdate.releasePointer, packageRoot)
    : { dir: packageRoot, sha: null, published: false });
  const record = createLauncherRecord(selfUpdate.record, {
    checkout: checkout ? packageRoot : null,
    releasesDir: selfUpdate.releasesDir,
    releasePointer: selfUpdate.releasePointer,
    requestFile: selfUpdate.request,
    port: options.port,
    socket: runtimeHostConfig.socketPath,
  });

  const runtimeHostSupervisor = createRuntimeHostSupervisor(
    runtimeHostConfig,
    viewerServerBunRuntime(),
    runtimeHostEnvironment,
    packageRoot,
    {
      release: releaseNow,
      onStarted: (child, release) => record.started("runtimeHost", child, release),
      onReady: () => record.set("runtimeHost", { state: "healthy", error: null }),
      onStopping: () => record.set("runtimeHost", { state: "stopping" }),
      onExit: (child, spawnedAt) => record.set("runtimeHost", { state: "failed", error: exitError(child, spawnedAt) }),
      onLaunchFailed: (child, spawnedAt, exitedOnItsOwn, detail) => record.set("runtimeHost", {
        state: "failed",
        error: exitedOnItsOwn ? exitError(child, spawnedAt) : { kind: "message", text: detail },
      }),
    },
  );
  try {
    await runtimeHostSupervisor.start();
  } catch (error) {
    await runtimeHostSupervisor.stop();
    record.remove();
    fail(m.runtimeHostStartFail(error instanceof Error ? error.message : String(error)));
  }

  const tailscaleProcessRef = { current: null };
  const serverRef = { current: null, release: releaseNow() };
  const launchWeb = (release, restarting) => {
    const handle = startServer(
      resolveServer(release.dir, options.hostname),
      options,
      runtime,
      tailscaleProcessRef,
      runtimeHostSupervisor,
      release.dir,
      runtimeHostEnvironment,
      {
        restarting,
        extraEnv: { LLV_SELF_UPDATE_RECORD: selfUpdate.record },
        onUnexpectedExit: (child) => record.set("web", { state: "failed", error: exitError(child, handle.startedAt) }),
      },
    );
    handle.startedAt = Date.now();
    serverRef.current = handle;
    serverRef.release = release;
    record.started("web", handle.child, release);
    return handle;
  };
  const serverProcess = launchWeb(serverRef.release, false);
  let restartRequests = null;
  installSignalHandlers(serverRef, tailscaleProcessRef, runtimeHostSupervisor, () => {
    restartRequests?.stop();
    record.remove();
  });

  /* The --tailscale switch keeps its foreground serve, which stops with the
     Viewer. The remembered choice publishes in the background once the
     server answers, and leaves the mapping to tailscaled at exit. */
  if (options.tailscale && runtime.tailscalePath && !options.tailscaleFromFlag) {
    tailscaleProcessRef.current = serveTailscale(runtime.tailscalePath, options.port);
  }

  try {
    await waitForReadiness(options.port);
  } catch (error) {
    await stopAll(serverProcess, tailscaleProcessRef.current, runtimeHostSupervisor);
    fail(error instanceof Error ? error.message : m.serverNotReady());
  }

  // Verify the kernel-visible bind after readiness. This catches a launcher or
  // framework silently widening a requested loopback bind before the listener
  // can remain exposed.
  if (isLoopbackHostname(options.hostname)) {
    let exposedAddress = null;
    try {
      const bindStateAfterLaunch = await readNonLoopbackBindState(options.port);
      // An address the guard could not evaluate narrows what it covered, so say
      // which. Recording it where nobody reads it would make a security check
      // degrade in silence.
      if (bindStateAfterLaunch.unevaluated.size > 0) {
        console.error(m.bindCheckSkipped([...bindStateAfterLaunch.unevaluated.keys()].join(", ")));
      }
      exposedAddress = newlyBoundNonLoopbackAddress(bindStateBeforeLaunch, bindStateAfterLaunch);
    } catch (error) {
      await stopAll(serverProcess, tailscaleProcessRef.current, runtimeHostSupervisor);
      fail(m.bindCheckFail(error instanceof Error ? error.message : String(error)));
    }
    if (exposedAddress !== null) {
      await stopAll(serverProcess, tailscaleProcessRef.current, runtimeHostSupervisor);
      fail(m.unexpectedNonLocalBind(exposedAddress));
    }
  }

  if (
    serverProcess.state.sawAddressInUse ||
    serverProcess.child.exitCode !== null ||
    serverProcess.child.signalCode !== null
  ) {
    process.exit(serverProcess.state.sawAddressInUse ? 1 : (serverProcess.child.exitCode ?? 1));
  }
  record.set("web", { state: "healthy", error: null });

  /* Restart requests are taken only once startup has finished, and only from
     a checkout: a packaged install is updated by its package manager. */
  if (checkout) {
    const restartWeb = async () => {
      const previous = serverRef.current;
      const previousRelease = serverRef.release;
      record.set("web", { state: "stopping" });
      await stopChild(previous);
      const attempt = async (release) => {
        const handle = launchWeb(release, true);
        try {
          await waitForReadiness(options.port, RESTART_READINESS_TIMEOUT_MS, handle);
          const page = await probePageAndChunk(options.port);
          if (page) throw new Error(page);
          handle.state.restarting = false;
          if (handle.child.exitCode !== null || handle.child.signalCode !== null) throw new Error("exited as it became ready");
          return null;
        } catch (error) {
          await stopChild(handle);
          return error instanceof Error ? error.message : String(error);
        }
      };
      const next = releaseNow();
      const failure = await attempt(next);
      if (failure === null) {
        record.set("web", { state: "healthy", error: null });
        return;
      }
      /* The web process is the page the operator restarts from: a release
         that does not come up gives way to the one it replaced. */
      const fallbackFailure = await attempt(previousRelease);
      if (fallbackFailure === null) {
        record.set("web", { state: "healthy", error: { kind: "fell-back", revision: next.sha ? next.sha.slice(0, 7) : null, detail: failure } });
        return;
      }
      record.set("web", { state: "failed", error: { kind: "message", text: fallbackFailure } });
      restartRequests?.stop();
      await stopAll(null, tailscaleProcessRef.current, runtimeHostSupervisor);
      fail(fallbackFailure);
    };
    const restartHost = async () => {
      try {
        const fellBack = await runtimeHostSupervisor.restart();
        if (fellBack) {
          record.set("runtimeHost", { state: "healthy", error: { kind: "fell-back", revision: fellBack.sha ? fellBack.sha.slice(0, 7) : null, detail: fellBack.detail } });
        }
      } catch (error) {
        record.set("runtimeHost", { state: "failed", error: { kind: "message", text: error instanceof Error ? error.message : String(error) } });
      }
    };
    restartRequests = watchRestartRequests(selfUpdate.request, async ({ requestId, role }) => {
      const key = role === "web" ? "web" : "runtimeHost";
      record.set(key, { requestId });
      if (role === "web") await restartWeb();
      else await restartHost();
    });
  }

  if (options.tailscaleFromFlag && runtime.tailscalePath) {
    const published = await serveBackground(runtime.tailscalePath, options.port);
    if (published.timedOut || published.code !== 0) {
      const detail = published.timedOut ? "timeout" : published.stderr.trim() || `exit ${published.code}`;
      console.error(OPERATOR_PATTERN.test(published.stderr) ? OPERATOR_HINT : m.phoneServeFailed(detail));
      /* Nothing is published, so the tailnet address answers nothing: the
         banner and its QR would be an invitation to a link that is not
         there. The gate stays on — the key was minted for this start. */
      runtime.tailnetUrl = undefined;
    }
  }

  const browser = !options.noOpen && process.stdout.isTTY
    ? await openBrowser(localUrl(options, runtime))
    : "not-opened";
  printBanner(version, options, runtime, browser, debug);
  if (options.tailscale) {
    await printTailscaleBanner(runtime);
  }
  startupOutput.release();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
