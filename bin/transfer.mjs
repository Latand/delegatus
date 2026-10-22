/*
 * `delegatus export` and `delegatus import` (docs/design/install-memory-transfer.md
 * §4.1–§4.2): a client of the running Viewer over loopback. It never opens
 * live state for writing; the Viewer's worker does the work under the state
 * ownership rules. It presents the host's controller credential, minted from
 * the operator key in the state directory exactly as the deploy client does,
 * resolves and pins a loopback address, refuses redirects, and prints no
 * credential.
 *
 *   delegatus export [--sections a,b] [--plain] [--out FILE | -]
 *   delegatus import FILE|- [--dry-run] [--map SOURCE_KEY=FOLDER ...] [--replace a,b] [--yes] [--passphrase-file FILE]
 *   delegatus import --report [IMPORT_ID]
 *
 * Plain ESM with node builtins only, loaded by the launcher before any
 * TypeScript is reachable.
 */

import { lookup } from "node:dns/promises";
import { closeSync, createReadStream, openSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { INTERNAL_SERVICE_HEADER, internalServiceTagFor, OPERATOR_SPAWN_CAPABILITY_FILE } from "./internalService.mjs";
import { generatePassphrase, isSealedBundle, sealBundle, TransferSealError, unsealBundle } from "./transferSeal.mjs";
import { viewerBootGateKey } from "./viewerGateKey.mjs";

const DEFAULT_PORT = 8898;

function detectLang(env) {
  const explicit = (env.LLV_LANG || env.DELEGATUS_LANG || "").toLowerCase();
  if (explicit === "uk" || explicit === "en") return explicit;
  const locale = (env.LC_ALL || env.LANG || "").toLowerCase();
  return locale === "uk" || locale.startsWith("uk_") || locale.startsWith("uk.") ? "uk" : "en";
}

const TEXT = {
  en: {
    usage: [
      "Usage:",
      "  delegatus export [--sections a,b] [--plain] [--out FILE | -]",
      "      Writes this install's memory and settings to a bundle, sealed with a passphrase shown once.",
      "      --plain leaves it unsealed, for a pipe over SSH: delegatus export --plain - | ssh server delegatus import -",
      "  delegatus import FILE|- [--dry-run] [--map SOURCE_KEY=FOLDER ...] [--replace a,b] [--yes] [--passphrase-file FILE]",
      "      Shows what the bundle would change here, then applies it after you confirm.",
      "  delegatus import --report [IMPORT_ID]",
      "      Prints the verification report of the last import.",
    ].join("\n"),
    notRunning: (verb) => `Delegatus is not running here. Start Delegatus, then ${verb}.`,
    refused: "The running Delegatus refused this client: run the command as the user who runs Delegatus.",
    failed: (status, message) => `The transfer failed (HTTP ${status}): ${message}`,
    passphrase: (value) => `Passphrase (shown once, not stored anywhere): ${value}`,
    wrote: (file, bytes) => `Wrote ${file} (${bytes} bytes).`,
    engineMemory: (files) => `Note: ${files} engine memory files on this install were never imported into Delegatus memory, so they are not in this bundle. Switch this install to Delegatus memory first, which imports them (the memory source switch: PUT /api/memory/source with {"source":"delegatus"}), then export again.`,
    askPassphrase: "Passphrase of the sealed bundle: ",
    needPassphrase: "This bundle is sealed: pass --passphrase-file FILE, or run in a terminal to type the passphrase.",
    badPassphrase: "The passphrase is wrong or the bundle is damaged.",
    askFolder: (name, key) => `Folder on this install for «${name}» (${key}); empty leaves it unmapped: `,
    askApply: "Apply this import? [y/N] ",
    cancelled: "Nothing was applied.",
    previous: (id, at) => `This bundle was imported here before (${id}, ${at}); only what was skipped then is applied.`,
    sectionLine: (s) => `  ${s.name.padEnd(18)} ${String(s.records).padStart(6)} records: ${s.new} new, ${s.same} same, ${s.conflict} conflict, ${s.skipped} skipped${s.pending ? ` (${s.pending} wait for their target)` : ""}`,
    unmapped: (names) => `Folders not mapped (their records arrive under the source key and match nothing): ${names}`,
    redo: "Still to do on this install:",
    applied: (ms) => `Applied in ${ms} ms.`,
    incomplete: "The report found a difference; see the sections and scopes above.",
    scopeLine: (s) => `${s.scope}: rules ${s.source.rules}→${s.target.rules}, active ${s.source.active}→${s.target.active}, code points ${s.source.codePoints}→${s.target.codePoints}${s.overBudget ? " (over the 10 000 target: the next curation trims it)" : ""}`,
    accountState: { unchecked: "signed in, not checked yet", signed_out: "signed out", usable: "ready", different_account: "signed into a different account", read_failed: "limits not read", not_needed: "not needed here", not_created: "not created" },
    accountsPending: "Memory and settings arrived. Sign in each account from the accounts panel's checklist, then run delegatus import --report.",
    noReport: "No import has been applied on this install.",
  },
  uk: {
    usage: [
      "Використання:",
      "  delegatus export [--sections a,b] [--plain] [--out ФАЙЛ | -]",
      "      Записує пам'ять і налаштування цієї інсталяції в пакет, запечатаний паролем, який показується один раз.",
      "      --plain лишає пакет незапечатаним для передачі через SSH: delegatus export --plain - | ssh server delegatus import -",
      "  delegatus import ФАЙЛ|- [--dry-run] [--map КЛЮЧ=ТЕКА ...] [--replace a,b] [--yes] [--passphrase-file ФАЙЛ]",
      "      Показує, що пакет змінить тут, і застосовує його після підтвердження.",
      "  delegatus import --report [ID]",
      "      Друкує звіт перевірки останнього імпорту.",
    ].join("\n"),
    notRunning: (verb) => `Delegatus тут не запущено. Запустіть Delegatus, потім ${verb === "import" ? "імпортуйте" : "експортуйте"}.`,
    refused: "Запущений Delegatus відмовив цьому клієнту: запустіть команду від користувача, під яким працює Delegatus.",
    failed: (status, message) => `Перенесення не вдалося (HTTP ${status}): ${message}`,
    passphrase: (value) => `Пароль (показується один раз і ніде не зберігається): ${value}`,
    wrote: (file, bytes) => `Записано ${file} (${bytes} байтів).`,
    engineMemory: (files) => `Увага: ${files} файлів пам'яті рушіїв на цій інсталяції ніколи не імпортовано в пам'ять Delegatus, тож їх немає в пакеті. Спершу перемкніть цю інсталяцію на пам'ять Delegatus, що імпортує їх (перемикач джерела пам'яті: PUT /api/memory/source з {"source":"delegatus"}), потім експортуйте знову.`,
    askPassphrase: "Пароль запечатаного пакета: ",
    needPassphrase: "Пакет запечатано: передайте --passphrase-file ФАЙЛ або запустіть у терміналі, щоб ввести пароль.",
    badPassphrase: "Пароль неправильний або пакет пошкоджено.",
    askFolder: (name, key) => `Тека на цій інсталяції для «${name}» (${key}); порожньо — не зіставляти: `,
    askApply: "Застосувати цей імпорт? [y/N] ",
    cancelled: "Нічого не застосовано.",
    previous: (id, at) => `Цей пакет уже імпортували тут (${id}, ${at}); застосується лише те, що тоді пропустили.`,
    sectionLine: (s) => `  ${s.name.padEnd(18)} ${String(s.records).padStart(6)} записів: ${s.new} нових, ${s.same} однакових, ${s.conflict} конфліктів, ${s.skipped} пропущено${s.pending ? ` (${s.pending} чекають на свою ціль)` : ""}`,
    unmapped: (names) => `Не зіставлені теки (їхні записи прийдуть під ключем джерела й ні з чим не збіжуться): ${names}`,
    redo: "Ще треба зробити на цій інсталяції:",
    applied: (ms) => `Застосовано за ${ms} мс.`,
    incomplete: "Звіт знайшов розбіжність; дивіться розділи й області вище.",
    scopeLine: (s) => `${s.scope}: правил ${s.source.rules}→${s.target.rules}, активних ${s.source.active}→${s.target.active}, символів ${s.source.codePoints}→${s.target.codePoints}${s.overBudget ? " (понад ціль 10 000: наступне курування скоротить)" : ""}`,
    accountState: { unchecked: "ввійдено, ще не перевірено", signed_out: "не ввійдено", usable: "готовий", different_account: "ввійдено в інший обліковий запис", read_failed: "ліміти не прочитано", not_needed: "тут не потрібен", not_created: "не створено" },
    accountsPending: "Пам'ять і налаштування прибули. Увійдіть у кожен обліковий запис за списком у панелі облікових записів, потім запустіть delegatus import --report.",
    noReport: "На цій інсталяції ще не застосовано жодного імпорту.",
  },
};

const REDO = {
  en: {
    account_sign_in: "sign in each account from the accounts panel's checklist",
    api_keys: "API keys and the Telegram bot token: Keys → Import with the source's Keys → Export text",
    telegram_bot: "connect the same Telegram bot; chat aliases and posting permission apply then (disconnect it on the source if it moves)",
    relay_pairing: "pair the relay again; its target settings apply then",
    forge_app_credential: "install the GitHub App credential for each declared repository",
    access_and_team: "the access key, phone access, push subscriptions, team members and linked installs",
    voice_tools: "voice tool secrets and approvals",
    subscription_consent: "confirm the subscription API consent",
    environment: "environment variables the source's Viewer had",
    unmapped_project: "folders left unmapped",
    manual_project_folder: "hand-made projects without a folder here",
    memory_source: "the source used this memory source; choose it here with the memory source switch (PUT /api/memory/source)",
    machine_worker_limit: "the source's machine worker limit (other hardware: set your own)",
    browser_preferences: "browser preferences (sound, theme, panel widths) stay with each browser",
  },
  uk: {
    account_sign_in: "увійдіть у кожен обліковий запис за списком у панелі облікових записів",
    api_keys: "API-ключі й токен Telegram-бота: Ключі → Імпорт із текстом Ключі → Експорт джерела",
    telegram_bot: "підключіть того самого Telegram-бота; псевдоніми чатів і дозвіл писати застосуються тоді (від'єднайте його на джерелі, якщо він переїжджає)",
    relay_pairing: "спарте ретранслятор знову; налаштування його цілей застосуються тоді",
    forge_app_credential: "встановіть облікові дані GitHub App для кожного оголошеного репозиторію",
    access_and_team: "ключ доступу, доступ із телефона, push-підписки, учасники команди й пов'язані інсталяції",
    voice_tools: "секрети й дозволи голосових інструментів",
    subscription_consent: "підтвердьте згоду на API підписки",
    environment: "змінні середовища, що були у Viewer джерела",
    unmapped_project: "незіставлені теки",
    manual_project_folder: "створені вручну проєкти без теки тут",
    memory_source: "джерело використовувало це джерело пам'яті; оберіть його тут перемикачем джерела пам'яті (PUT /api/memory/source)",
    machine_worker_limit: "ліміт працівників машини джерела (інше залізо: встановіть свій)",
    browser_preferences: "налаштування браузера (звук, тема, ширина панелей) лишаються в кожному браузері",
  },
};

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.exitCode = code; }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1] !== undefined) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

function options(args, name) {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) found.push(args[index + 1]);
    else if (args[index].startsWith(`${name}=`)) found.push(args[index].slice(name.length + 1));
  }
  return found;
}

/** The Viewer's address: --port, then LLV_VIEWER_CONTROL_URL, then the default port; loopback only, resolved once and pinned. */
export async function viewerAddress(args, env, resolve = (host) => lookup(host, { all: true })) {
  const port = option(args, "--port");
  const base = port ? `http://127.0.0.1:${port}` : (env.LLV_VIEWER_CONTROL_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`);
  const url = new URL(base);
  if (url.protocol !== "http:" || url.username || url.password) throw new CliError("the Viewer address must be a plain http loopback address", 2);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolve(host);
  if (!addresses.length || !addresses.every(({ address }) => (isIP(address) === 4 ? address.split(".")[0] === "127" : address === "::1"))) {
    throw new CliError("the Viewer address must resolve only to loopback", 2);
  }
  const address = addresses[0].address;
  return { host: address, port: Number(url.port || 80) };
}

/** The controller credential and the access key, read here and never printed. */
export function credentialHeaders(stateDirectory, env) {
  const headers = {};
  try {
    const key = readFileSync(join(stateDirectory, OPERATOR_SPAWN_CAPABILITY_FILE), "utf8").trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(key)) headers[INTERNAL_SERVICE_HEADER] = `controller.${internalServiceTagFor(key, "controller")}`;
  } catch { /* no key: the Viewer refuses, and says so */ }
  const bearer = viewerBootGateKey({ ...env, LLV_STATE_DIR: stateDirectory });
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

function call(address, headers, { method, path, body, contentType, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: address.host, port: address.port, method, path, headers: {
      ...headers, ...extraHeaders, ...(body ? { "content-type": contentType, "content-length": body.length } : {}),
    }, timeout: 20 * 60_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

async function request(context, init, verb) {
  let response;
  try { response = await call(context.address, context.headers, init); }
  catch (error) {
    if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH"].includes(error?.code)) throw new CliError(context.text.notRunning(verb), 3);
    throw new CliError(context.text.notRunning(verb), 3);
  }
  if (response.status >= 300 && response.status < 400) throw new CliError("the Viewer answered with a redirect; refused", 3);
  if (response.status === 401 || response.status === 403) throw new CliError(context.text.refused, 3);
  return response;
}

function jsonOf(context, response) {
  let parsed = null;
  try { parsed = JSON.parse(response.body.toString("utf8")); } catch { parsed = null; }
  if (response.status !== 200 || !parsed?.ok) {
    throw new CliError(context.text.failed(response.status, parsed?.error?.message ?? "no readable answer"), response.status === 409 ? 4 : 1);
  }
  return parsed.result;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function terminal() {
  try {
    const fd = openSync("/dev/tty", "r+");
    closeSync(fd);
    return { input: createReadStream("/dev/tty"), output: process.stderr };
  } catch { return null; }
}

async function ask(io, question) {
  if (!io) return null;
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  io.output.write(question);
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally { rl.close(); }
}

function printPlan(context, plan) {
  const { log, text } = context;
  if (plan.previousImport) log(text.previous(plan.previousImport.importId, plan.previousImport.at));
  for (const section of plan.sections) log(text.sectionLine(section));
  const unmapped = plan.projects.filter((project) => project.state === "unmapped");
  if (unmapped.length) log(text.unmapped(unmapped.map((project) => `${project.displayName} (${project.key})`).join(", ")));
  if (plan.notices?.length) for (const notice of plan.notices) if (notice.code === "engine_memory_not_imported") log(text.engineMemory(notice.files));
  printRedo(context, plan.redo);
}

function printRedo(context, redo) {
  const { log, text, lang } = context;
  if (!redo?.length) return;
  log(text.redo);
  for (const item of redo) log(`  - ${REDO[lang][item.code] ?? item.code}${item.count ? ` (${item.count})` : ""}${item.detail ? `: ${item.detail}` : ""}`);
}

function printReport(context, report) {
  const { log, text } = context;
  for (const section of report.sections) log(`${section.balanced ? "✓" : "✗"}${text.sectionLine(section).slice(1)}`);
  for (const scope of report.scopes) {
    log(`${scope.ok ? "✓" : "✗"} ${text.scopeLine(scope)}`);
  }
  for (const account of report.accounts ?? []) log(`  ${account.engine} «${account.label}»: ${text.accountState[account.state] ?? account.state}${account.detail ? ` (${account.detail})` : ""}`);
  printRedo(context, report.redo);
  log(text.applied(report.applyMs));
  if (!report.complete) log(text.incomplete);
  else if (report.accountsReady === false) log(text.accountsPending);
}

async function runExport(args, context) {
  const sections = option(args, "--sections");
  const response = await request(context, {
    method: "POST", path: "/api/transfer/export", contentType: "application/json",
    body: Buffer.from(JSON.stringify(sections ? { sections: sections.split(",").map((name) => name.trim()).filter(Boolean) } : {})),
  }, "export");
  if (response.status !== 200 || response.headers["content-type"] !== "application/octet-stream") jsonOf(context, response);
  let summary = {};
  try { summary = JSON.parse(String(response.headers["x-delegatus-transfer"] ?? "{}")); } catch { summary = {}; }
  let bytes = response.body;
  const plain = args.includes("--plain");
  let passphrase = null;
  if (!plain) {
    passphrase = context.passphrase();
    bytes = sealBundle(bytes, passphrase);
  }
  const out = option(args, "--out") ?? (args.includes("-") ? "-" : `delegatus-transfer-${context.now().toISOString().slice(0, 10)}.dlgt`);
  if (out === "-") context.writeStdout(bytes);
  else {
    writeFileSync(out, bytes, { mode: 0o600, flag: "wx" });
    context.err(context.text.wrote(out, bytes.length));
  }
  if (passphrase) context.err(context.text.passphrase(passphrase));
  for (const notice of summary.notices ?? []) if (notice.code === "engine_memory_not_imported") context.err(context.text.engineMemory(notice.files));
  return 0;
}

async function runImport(args, context) {
  if (args.includes("--report")) {
    const id = args[args.indexOf("--report") + 1];
    const query = id && !id.startsWith("--") ? `?importId=${encodeURIComponent(id)}` : "";
    /* §5.2: each account the import brought reads its limits live before the report prints. */
    jsonOf(context, await request(context, { method: "POST", path: "/api/transfer/accounts", contentType: "application/json", body: Buffer.from(JSON.stringify({ action: "verify" })) }, "import"));
    const report = jsonOf(context, await request(context, { method: "GET", path: `/api/transfer/report${query}` }, "import"));
    if (!report) { context.log(context.text.noReport); return 1; }
    printReport(context, report);
    return report.complete && report.accountsReady !== false ? 0 : 5;
  }
  const source = args.find((arg, index) => !arg.startsWith("--") && !["--map", "--replace", "--passphrase-file", "--port"].includes(args[index - 1]));
  if (!source) { context.log(context.text.usage); return 2; }
  let bytes = source === "-" ? await context.readStdin() : readFileSync(source);
  const io = context.terminal();
  if (isSealedBundle(bytes)) {
    const file = option(args, "--passphrase-file");
    const passphrase = file ? readFileSync(file, "utf8").trim() : await ask(io, context.text.askPassphrase);
    if (!passphrase) throw new CliError(context.text.needPassphrase, 2);
    try { bytes = unsealBundle(bytes, passphrase); }
    catch (error) { throw new CliError(error instanceof TransferSealError ? context.text.badPassphrase : String(error), 2); }
  }
  const mappings = {};
  for (const entry of options(args, "--map")) {
    const at = entry.indexOf("=");
    if (at > 0) mappings[entry.slice(0, at)] = entry.slice(at + 1);
  }
  const replace = option(args, "--replace")?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
  const preview = async () => jsonOf(context, await request(context, {
    method: "POST", path: "/api/transfer/preview", contentType: "application/octet-stream", body: bytes,
    extraHeaders: { "x-delegatus-transfer-options": JSON.stringify({ mappings, replace }) },
  }, "import"));
  let plan = await preview();
  const yes = args.includes("--yes");
  if (!args.includes("--dry-run") && !yes && io) {
    let asked = false;
    for (const project of plan.projects.filter((candidate) => candidate.state === "unmapped" && !mappings[candidate.key])) {
      const folder = await ask(io, context.text.askFolder(project.displayName, project.key));
      if (folder) { mappings[project.key] = folder; asked = true; }
    }
    if (asked) plan = await preview();
  }
  printPlan(context, plan);
  if (args.includes("--dry-run")) return 0;
  if (!yes) {
    const answer = await ask(io, context.text.askApply);
    if (!answer || !/^(y|yes|т|так)$/i.test(answer)) { context.log(context.text.cancelled); return 1; }
  }
  const report = jsonOf(context, await request(context, {
    method: "POST", path: "/api/transfer/apply", contentType: "application/json",
    body: Buffer.from(JSON.stringify({ bundleSha256: plan.bundleSha256, revisions: plan.revisions, mappings, replace })),
  }, "import"));
  printReport(context, report);
  return report.complete ? 0 : 5;
}

/**
 * @param {"export" | "import"} command
 * @param {string[]} args
 * @param {{ stateDirectory: string, env?: Record<string, string | undefined>, log?: (line: string) => void, err?: (line: string) => void,
 *   writeStdout?: (bytes: Buffer) => void, readStdin?: () => Promise<Buffer>, terminal?: () => unknown, passphrase?: () => string, now?: () => Date,
 *   resolve?: (host: string) => Promise<{ address: string }[]> }} context
 * @returns {Promise<number>} the exit code
 */
export async function runTransferCommand(command, args, context) {
  const env = context.env ?? process.env;
  const lang = detectLang(env);
  const text = TEXT[lang];
  const log = context.log ?? ((line) => console.log(line));
  const full = {
    lang, text, log,
    err: context.err ?? ((line) => console.error(line)),
    writeStdout: context.writeStdout ?? ((bytes) => process.stdout.write(bytes)),
    readStdin: context.readStdin ?? (() => readAll(process.stdin)),
    terminal: context.terminal ?? terminal,
    passphrase: context.passphrase ?? (() => generatePassphrase()),
    now: context.now ?? (() => new Date()),
  };
  if (args.includes("--help") || args.includes("-h")) { log(text.usage); return 0; }
  try {
    full.address = await viewerAddress(args, env, context.resolve);
    full.headers = credentialHeaders(context.stateDirectory, env);
    return command === "export" ? await runExport(args, full) : await runImport(args, full);
  } catch (error) {
    if (error instanceof CliError) { full.err(error.message); return error.exitCode; }
    full.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
