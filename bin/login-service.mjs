import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { assertLauncherAvailable, portFree } from "./launcher-adoption.mjs";
import { cliRuntimeHostConfig } from "./server-runtime.mjs";

export const SERVICE_MARKER = 'Written by "delegatus service install". "delegatus service remove" deletes it.';
import { SERVICE_NAME, AGENT_NAME, serviceCommand } from "./service-manager.mjs";
const SETTINGS = ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LANG", "LC_ALL", "LLV_LANG", "DELEGATUS_TELEMETRY", "LLV_TELEMETRY", "DO_NOT_TRACK"];

export function serviceContainer(env = process.env) {
  return env.LLV_DOCKER_NSENTER_SHIMS === "1" || existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export function loginServiceHost() {
  return {
    platform: process.platform, uid: process.getuid?.() ?? -1, home: homedir(), accountHome: userInfo().homedir,
    env: { ...process.env }, bun: process.versions.bun ? process.execPath : "", temp: tmpdir(),
    container: serviceContainer(),
    run: serviceCommand,
    live(record) { try { assertLauncherAvailable({ record }); return false; } catch { return true; } },
    portFree,
  };
}

function safe(value) {
  if (typeof value !== "string" || /["\x00-\x1f\x7f]/.test(value)) throw new Error("unsafe-value");
  return value;
}
function systemd(value) { return '"' + safe(value).replaceAll("\\", "\\\\").replaceAll("%", "%%").replaceAll("$", () => "$$") + '"'; }
function environmentValue(value) { return '"' + safe(value).replaceAll("\\", "\\\\").replaceAll("%", "%%") + '"'; }
function xml(value) { return safe(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;"); }
function shellWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function serviceEnvironment(env) {
  const captured = { PATH: env.PATH || "/usr/bin:/bin" };
  for (const name of SETTINGS) if (env[name] !== undefined) captured[name] = env[name];
  // CLI aliases are normalized before dispatch. Also accept callers using this module directly.
  for (const name of SETTINGS.filter(name => name.startsWith("LLV_"))) {
    const alias = `DELEGATUS_${name.slice(4)}`;
    if (env[alias] !== undefined) captured[name] = env[alias];
  }
  for (const value of Object.values(captured)) safe(value);
  return captured;
}

export function renderLoginService({ platform, root, bun, port, env, home }) {
  const args = [bun, path.join(root, "bin", "cli.mjs"), "--no-open", "--port", String(port)];
  if (platform === "linux") return `# ${SERVICE_MARKER}\n[Unit]\nDescription=Delegatus\nStartLimitIntervalSec=600\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=${args.map(systemd).join(" ")}\n${Object.entries(env).map(([key, value]) => `Environment=${environmentValue(`${key}=${value}`)}`).join("\n")}\nRestart=on-failure\nRestartSec=5\nKillMode=process\nTimeoutStopSec=120\nOOMPolicy=continue\nOOMScoreAdjust=100\n\n[Install]\nWantedBy=default.target\n`;
  const log = path.join(home, "Library", "Logs", "Delegatus", "server.log");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${SERVICE_MARKER} -->\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${AGENT_NAME}</string>\n  <key>ProgramArguments</key>\n  <array>${args.map(value => `<string>${xml(value)}</string>`).join("")}</array>\n  <key>EnvironmentVariables</key>\n  <dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>ExitTimeOut</key><integer>120</integer>\n  <key>StandardOutPath</key><string>${xml(log)}</string>\n  <key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict>\n</plist>\n`;
}

const COPY = {
  en: {
    usage: "Usage: delegatus service install [--port <n>] | delegatus service remove",
    unsupported: "Start at login is available on Linux and macOS.", root: "Run as the user who uses Delegatus, without sudo.",
    container: "Use the container's restart policy. See docs/docker.md.", bun: "Run this command with Bun.",
    checkout: "A checkout keeps its own service and deploy procedure. See docs/guide/operations.md and docs/deploy-checkout.md.",
    temporary: "Install the command with bun add -g delegatus-cli, then run delegatus service install.",
    package: "Run the installed command. Run bun add -g delegatus-cli@latest, then try again.",
    old: "Your installed command is older than this release. Run bun add -g delegatus-cli@latest, then run this again.",
    manager: "The per-user service manager is unavailable. Use a desktop login session with a user service manager.",
    foreign: "This service file belongs to another installation; nothing was changed:",
    state: "The service would use a different state directory:", unsafe: "A path or setting contains a quote or control character; use a plain value.",
    changed: "The service file changed during the command. Retry after checking it.", failed: "The service manager refused the command. Check its log and retry.",
    already: "Already installed.", absent: "Not installed. Nothing to remove.", written: "Service file:", command: "Start command:", settings: "Captured settings:",
    running: "Delegatus is already running. The service starts it at your next login. To switch now: delegatus stop --all, then delegatus service install.",
    busy: "Port is busy; the service was not started:", next: "It starts at the next desktop login.",
    later: "Changes apply at the next start (on macOS, next login). Restart at a quiet moment:",
    check: "Check: delegatus doctor", undo: "Undo: delegatus service remove", removed: "Removed:", stopped: "Delegatus stopped. Run delegatus to start it from a terminal.",
    dropin: "Your service drop-ins were left in place:",
  },
  uk: {
    usage: "Використання: delegatus service install [--port <n>] | delegatus service remove",
    unsupported: "Запуск під час входу доступний у Linux і macOS.", root: "Запустіть від користувача, який працює з Delegatus, без sudo.",
    container: "Скористайтеся політикою перезапуску контейнера. Див. docs/docker.md.", bun: "Запустіть цю команду через Bun.",
    checkout: "Клон репозиторію використовує власну службу й процедуру деплою. Див. docs/guide/operations.md і docs/deploy-checkout.md.",
    temporary: "Встановіть команду через bun add -g delegatus-cli, потім виконайте delegatus service install.",
    package: "Запустіть встановлену команду. Виконайте bun add -g delegatus-cli@latest і повторіть спробу.",
    old: "Встановлена команда старіша за цей реліз. Виконайте bun add -g delegatus-cli@latest і повторіть спробу.",
    manager: "Менеджер служб користувача недоступний. Увійдіть у сеанс із менеджером служб користувача.",
    foreign: "Цей файл служби належить іншій установці; нічого не змінено:",
    state: "Служба використовуватиме інший каталог стану:", unsafe: "Шлях або налаштування містить лапки чи керівний символ; використайте звичайне значення.",
    changed: "Файл служби змінився під час виконання команди. Перевірте його й повторіть спробу.", failed: "Менеджер служб відхилив команду. Перевірте журнал і повторіть спробу.",
    already: "Уже встановлено.", absent: "Не встановлено. Видаляти нічого.", written: "Файл служби:", command: "Команда запуску:", settings: "Збережені налаштування:",
    running: "Delegatus уже працює. Служба запустить його під час наступного входу. Щоб перейти зараз: delegatus stop --all, потім delegatus service install.",
    busy: "Порт зайнятий; службу не запущено:", next: "Запуск відбудеться під час наступного входу в робочий стіл.",
    later: "Зміни діятимуть із наступного запуску (у macOS — входу). Перезапустіть у вільний момент:",
    check: "Перевірка: delegatus doctor", undo: "Скасування: delegatus service remove", removed: "Видалено:", stopped: "Delegatus зупинено. Команда delegatus запустить його з термінала.",
    dropin: "Ваші додаткові налаштування служби збережено:",
  },
};

function ownedFile(file, copy) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${copy.foreign} ${file}`);
    const bytes = readFileSync(file, "utf8");
    if (!bytes.startsWith(`# ${SERVICE_MARKER}\n`) && !bytes.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${SERVICE_MARKER} -->\n`)) throw new Error(`${copy.foreign} ${file}`);
    return bytes;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function assertFile(file, expected, copy) {
  if (ownedFile(file, copy) !== expected) throw new Error(copy.changed);
}

function replaceFile(file, previous, bytes, copy) {
  assertFile(file, previous, copy);
  mkdirSync(path.dirname(file), { recursive: true });
  if (previous === null) { writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); return; }
  const temporary = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    assertFile(file, previous, copy);
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}

function properties(text) {
  return Object.fromEntries(text.trim().split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function managerConfigHome(text, fallback) {
  const raw = properties(text).XDG_CONFIG_HOME;
  if (raw === undefined) return fallback;
  // show-environment uses shell quoting. Decode a value without evaluating it.
  let value = "", quote = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "'" && quote !== '"' || char === '"' && quote !== "'") { quote = quote ? "" : char; continue; }
    if (char === "\\" && quote !== "'") { if (++i >= raw.length) throw new Error("unsafe-value"); value += raw[i]; }
    else value += char;
  }
  if (quote) throw new Error("unsafe-value");
  return safe(value);
}

function stableBun(host) {
  for (const dir of (host.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "bun");
    try { if (realpathSync(candidate) === realpathSync(host.bun)) return candidate; } catch { /* next candidate */ }
  }
  return host.bun;
}

/** @param {string[]} args
 * @param {{root: string, lang?: 'en'|'uk', host?: ReturnType<typeof loginServiceHost>, log?: (line: string) => void}} context
 */
export async function runServiceCommand(args, { root, lang = "en", host = loginServiceHost(), log = console.log }) {
  const copy = COPY[lang];
  const [action, ...options] = args;
  let port = 8898;
  if (action === "install" && options.length === 2 && options[0] === "--port" && /^\d+$/.test(options[1])) port = Number(options[1]);
  else if (!["install", "remove"].includes(action) || options.length) { log(copy.usage); return 2; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { log(lang === "uk" ? `Некоректний порт: ${options[1]}` : `Invalid port: ${options[1]}`); return 1; }
  try {
    for (const [refused, message] of [
      [!["linux", "darwin"].includes(host.platform), copy.unsupported], [host.uid === 0, copy.root],
      [host.container, copy.container], [!host.bun, copy.bun], [host.env.LLV_LAUNCHER_REEXEC === "1", copy.old],
      [existsSync(path.join(root, ".git")), copy.checkout],
      [root === host.temp || root.startsWith(host.temp + path.sep) || /(?:^|\/)bunx-\d+-/.test(root), copy.temporary],
      [/(?:^|\/)self-update\/[^/]+\/releases\//.test(root) || !existsSync(path.join(root, "dist", "standalone", "server.js")) || !existsSync(path.join(root, "dist", "runtime-host.mjs")), copy.package],
    ]) if (refused) throw new Error(message);
    const env = serviceEnvironment(host.env);
    const bun = stableBun(host);
    for (const value of [root, bun, host.home, host.accountHome]) safe(value);
    const manual = cliRuntimeHostConfig(root, { env: { ...host.env, ...env }, home: host.home });
    const managed = cliRuntimeHostConfig(root, { env, home: host.accountHome });
    if (manual.stateDirectory !== managed.stateDirectory) throw new Error(`${copy.state} ${manual.stateDirectory} / ${managed.stateDirectory}`);
    const record = path.join(manual.stateDirectory, "self-update", `launcher-${manual.installId}.json`);
    const linux = host.platform === "linux";
    const domain = `gui/${host.uid}`;
    const job = `${domain}/${AGENT_NAME}`;
    const call = (args) => host.run(linux ? "systemctl" : "launchctl", linux ? ["--user", ...args] : args, {
      env: host.env, timeoutMs: ["disable", "bootout"].includes(args[0]) ? 125_000 : 5000,
    });
    const requireCall = async args => { const result = await call(args); if (result.code !== 0) throw new Error(copy.failed); return result; };
    let unit = {}, loaded = false, macRunning = false, graphical = true, config = path.join(host.accountHome, ".config");
    if (linux) {
      const manager = await call(["show", "--property=Version"]);
      if (manager.code !== 0) throw new Error(copy.manager);
      const managerEnv = await requireCall(["show-environment"]);
      config = managerConfigHome(managerEnv.stdout, config);
      if (!path.isAbsolute(config)) throw new Error(copy.manager);
      const shown = await call(["show", SERVICE_NAME, "--property=LoadState,FragmentPath,UnitFileState,ActiveState"]);
      unit = properties(shown.stdout);
      if (!unit.LoadState || shown.code !== 0 && unit.LoadState !== "not-found") throw new Error(copy.manager);
    } else {
      graphical = (await call(["print", domain])).code === 0;
      loaded = graphical && (await call(["print", job])).code === 0;
      if (loaded) {
        const listed = await requireCall(["list", AGENT_NAME]);
        macRunning = /"PID"\s*=\s*[1-9]\d*\s*;/.test(listed.stdout);
        if (!macRunning && !/"LastExitStatus"\s*=\s*-?\d+\s*;/.test(listed.stdout)) throw new Error(copy.manager);
      }
    }
    const file = linux ? path.join(config, "systemd", "user", SERVICE_NAME) : path.join(host.accountHome, "Library", "LaunchAgents", `${AGENT_NAME}.plist`);
    if (linux && unit.FragmentPath && unit.FragmentPath !== file) throw new Error(`${copy.foreign} ${unit.FragmentPath}`);
    const previous = ownedFile(file, copy);
    if (previous === null && (linux ? unit.LoadState !== "not-found" : loaded)) throw new Error(`${copy.foreign} ${file}`);
    if (action === "remove") {
      if (previous === null) {
        log(copy.absent); return 0;
      }
      assertFile(file, previous, copy);
      if (linux) await requireCall(["disable", "--now", SERVICE_NAME]);
      else if (loaded) await requireCall(["bootout", job]);
      assertFile(file, previous, copy);
      unlinkSync(file);
      if (linux) {
        await requireCall(["daemon-reload"]);
        try { await call(["reset-failed", SERVICE_NAME]); } catch { /* The owned unit has already been removed. */ }
      } else {
        try { unlinkSync(path.join(host.accountHome, "Library", "Logs", "Delegatus", "server.log")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { rmdirSync(path.join(host.accountHome, "Library", "Logs", "Delegatus")); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      }
      log(`${copy.removed} ${file}`);
      if (linux ? unit.ActiveState === "active" : macRunning) log(copy.stopped);
      if (linux && existsSync(`${file}.d`)) log(`${copy.dropin} ${file}.d`);
      return 0;
    }
    const bytes = renderLoginService({ platform: host.platform, root, bun, port, env, home: host.accountHome });
    const changed = bytes !== previous;
    if (changed) { replaceFile(file, previous, bytes, copy); log(`${copy.written} ${file}`); }
    const guarded = async args => { assertFile(file, bytes, copy); const result = await requireCall(args); assertFile(file, bytes, copy); return result; };
    if (linux) {
      if (changed) await guarded(["daemon-reload"]);
      if (unit.UnitFileState !== "enabled") await guarded(["enable", SERVICE_NAME]);
      if (unit.ActiveState === "failed") await guarded(["reset-failed", SERVICE_NAME]);
    } else if (changed) mkdirSync(path.join(host.accountHome, "Library", "Logs", "Delegatus"), { recursive: true });
    const active = linux ? ["active", "activating", "deactivating"].includes(unit.ActiveState) : macRunning;
    if (changed && (active || loaded)) log(`${copy.later} ${linux ? "systemctl --user restart delegatus.service" : `launchctl bootout ${job}; launchctl bootstrap ${domain} ${shellWord(file)}`}`);
    if (!active || (linux && unit.ActiveState === "failed")) {
      if (host.live(record)) log(copy.running);
      else if (!graphical) log(copy.next);
      else if (!await host.portFree(port)) log(`${copy.busy} ${port}`);
      else {
        assertFile(file, bytes, copy);
        // A launcher may have appeared while the port probe awaited.
        if (host.live(record)) log(copy.running);
        else await guarded(linux ? ["start", SERVICE_NAME] : loaded ? ["kickstart", job] : ["bootstrap", domain, file]);
      }
    }
    if (!changed) log(copy.already);
    log(`${copy.written} ${file}`);
    log(`${copy.command} ${[bun, path.join(root, "bin", "cli.mjs"), "--no-open", "--port", port].map(shellWord).join(" ")}`);
    log(`${copy.settings} ${Object.keys(env).join(", ")}`);
    log(linux ? "journalctl --user -u delegatus.service" : path.join(host.accountHome, "Library", "Logs", "Delegatus", "server.log"));
    log(copy.check); log(copy.undo);
    return 0;
  } catch (error) {
    log(error.message === "unsafe-value" ? copy.unsafe : error.code === "ENOENT" || error.killed ? copy.manager : error.message || copy.failed);
    return 1;
  }
}
