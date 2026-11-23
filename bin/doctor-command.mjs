// @ts-check
import { runDoctor, validDoctorPort } from "./doctor.mjs";

const COPY = {
  en: {
    heading: "Delegatus diagnostics (presence checks)",
    usage: "Usage: delegatus doctor [--json] [--port <n>]",
    failed: "Diagnostics could not complete.",
    labels: {
      "engine.claude": "Claude CLI", "engine.codex": "Codex CLI", "auth.codex": "Codex credential file",
      "transcripts.claude": "Claude transcript root", "transcripts.codex": "Codex transcript root",
      "transcription.local": "Local transcription", "viewer.server": "Viewer listener", "service.login": "Start at login",
    },
    states: { available: "present", degraded: "check needed", blocked: "missing", unknown: "unknown" },
    reasons: {
      CLI_MISSING: "Install the engine CLI, then reopen the setup guide.",
      AUTH_ABSENT: "Sign in to Codex through the setup guide. File presence does not verify a login.",
      TRANSCRIPT_ROOT_MISSING: "No transcript directory yet. History remains available for other engines.",
      WHISPER_VENV_MISSING: "Set up local transcription or choose another backend in the setup guide.",
      WHISPER_RUNTIME_UNCHECKED: "Python is present. The Whisper package and model have not been tested.",
      VIEWER_UNREACHABLE: "Start Delegatus, or pass the port used by this installation.",
      VIEWER_AUTH_REQUIRED: "A protected listener answered. Open Delegatus and sign in to verify access.",
      VIEWER_UNRECOGNIZED: "The listener did not identify the diagnostics endpoint. Check its port and version.",
      PROBE_TIMEOUT: "The read exceeded its deadline. Retry the check.",
      PROBE_ERROR: "The source could not be inspected. Check read permissions and retry.",
      SERVICE_NOT_INSTALLED: "Not installed: Delegatus does not start at login. delegatus service install adds it.",
      SERVICE_DISABLED: "Installed and turned off. delegatus service install turns it on.",
      SERVICE_NOT_RUNNING: "Installed and enabled. It starts at the next login.",
      SERVICE_RESTARTING: "It keeps failing to start. See its log.",
      SERVICE_FAILED: "It stopped after repeated failures. Read the log, fix the cause, run delegatus service install.",
      SERVICE_RUNNING: "Installed, enabled and running.",
      SERVICE_UNAVAILABLE: "No per-user service manager here.",
    },
  },
  uk: {
    heading: "Діагностика Delegatus (перевірка наявності)",
    usage: "Використання: delegatus doctor [--json] [--port <n>]",
    failed: "Не вдалося завершити діагностику.",
    labels: {
      "engine.claude": "CLI Claude", "engine.codex": "CLI Codex", "auth.codex": "Файл облікових даних Codex",
      "transcripts.claude": "Каталог розмов Claude", "transcripts.codex": "Каталог розмов Codex",
      "transcription.local": "Локальна транскрипція", "viewer.server": "Сервер Delegatus", "service.login": "Запуск під час входу",
    },
    states: { available: "наявне", degraded: "потрібна перевірка", blocked: "відсутнє", unknown: "невідомо" },
    reasons: {
      CLI_MISSING: "Встановіть CLI рушія й відкрийте посібник із налаштування знову.",
      AUTH_ABSENT: "Увійдіть у Codex через посібник із налаштування. Наявність файлу не підтверджує чинний вхід.",
      TRANSCRIPT_ROOT_MISSING: "Каталогу розмов ще немає. Історія інших рушіїв залишається доступною.",
      WHISPER_VENV_MISSING: "Налаштуйте локальну транскрипцію або виберіть інший сервіс у посібнику.",
      WHISPER_RUNTIME_UNCHECKED: "Python наявний. Пакет Whisper і модель ще не перевірено.",
      VIEWER_UNREACHABLE: "Запустіть Delegatus або вкажіть порт цієї установки.",
      VIEWER_AUTH_REQUIRED: "Відповів захищений сервер. Відкрийте Delegatus і ввійдіть, щоб перевірити доступ.",
      VIEWER_UNRECOGNIZED: "Сервер не підтвердив адресу діагностики. Перевірте його порт і версію.",
      PROBE_TIMEOUT: "Читання перевищило відведений час. Повторіть перевірку.",
      PROBE_ERROR: "Джерело не вдалося перевірити. Перевірте права читання й повторіть спробу.",
      SERVICE_NOT_INSTALLED: "Не встановлено: Delegatus не запускається під час входу. Команда delegatus service install додасть службу.",
      SERVICE_DISABLED: "Встановлено й вимкнено. Команда delegatus service install увімкне службу.",
      SERVICE_NOT_RUNNING: "Встановлено й увімкнено. Запуск відбудеться під час наступного входу.",
      SERVICE_RESTARTING: "Спроби запуску завершуються помилкою. Перегляньте журнал.",
      SERVICE_FAILED: "Зупинено після повторних помилок. Перегляньте журнал, усуньте причину й виконайте delegatus service install.",
      SERVICE_RUNNING: "Встановлено, увімкнено й запущено.",
      SERVICE_UNAVAILABLE: "Менеджер служб користувача тут недоступний.",
    },
  },
};

/** @param {import('../src/lib/doctor/contracts').CapabilityReport} report @param {'en' | 'uk'} [lang] */
export function formatDoctor(report, lang = "en") {
  const copy = COPY[lang];
  const glyphs = { available: "✓", degraded: "◐", blocked: "✗", unknown: "?" };
  return [copy.heading, ...report.capabilities.flatMap(capability => [
    `${glyphs[capability.state]} ${copy.labels[capability.id]}: ${copy.states[capability.state]}`,
    ...(capability.reason ? [`  ${copy.reasons[capability.reason]}`] : []),
    ...(capability.id === "service.login" && ["SERVICE_FAILED", "SERVICE_RESTARTING"].includes(capability.reason ?? "") ? [report.platform.os === "linux" ? "  journalctl --user -u delegatus.service" : "  ~/Library/Logs/Delegatus/server.log"] : []),
  ])].join("\n");
}

/** @param {string[]} args
 * @param {{ lang?: 'en' | 'uk'; run?: typeof runDoctor; log?: (line: string) => void }} [context]
 */
export async function runDoctorCommand(args, { lang = "en", run = runDoctor, log = console.log } = {}) {
  const copy = COPY[lang];
  let json = false;
  let port = 8898;
  let seenPort = false;
  for (let i = 0; i < args.length; i++) {
    if (["--help", "-h"].includes(args[i]) && args.length === 1) { log(copy.usage); return 0; }
    if (args[i] === "--json" && !json) { json = true; continue; }
    if (args[i] === "--port" && !seenPort && /^\d+$/.test(args[i + 1] ?? "")) {
      port = Number(args[++i]); seenPort = true;
      if (validDoctorPort(port)) continue;
    }
    log(copy.usage);
    return 2;
  }
  try {
    const report = await run({ port });
    log(json ? JSON.stringify(report) : formatDoctor(report, lang));
    return report.capabilities.some(capability => capability.state === "blocked") ? 1 : 0;
  } catch { log(copy.failed); return 2; }
}
