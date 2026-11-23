/*
 * What the routes behind the Settings window answer in the board drivers
 * (`?settings=<scene>` on the evidence fixture). Real shapes over invented bots,
 * chats, projects and tools; a press changes the record as the route does, and
 * `&refuse=1` refuses every write. Dates read 4 Nov 2026 on the page's clock.
 */

const params = new URLSearchParams(location.search);
export const SETTINGS_SCENE = params.get("settings");
const REFUSE = params.get("refuse") === "1";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const uk = () => localStorage.getItem("llv_lang") === "uk";
const L = (en: string, ukrainian: string) => uk() ? ukrainian : en;

/* ---- Privacy ---- */
const telemetry = { enabled: true, locked: SETTINGS_SCENE === "privacy-locked", noticeDismissed: SETTINGS_SCENE !== "privacy-notice", swarmRules: SETTINGS_SCENE === "privacy-swarm" };
if (telemetry.locked) telemetry.enabled = false;
let consent = true;

/* ---- Telegram ---- */
const MAIN = { name: "Delegatus Atlas", username: "atlas_delegatus_bot", receiving: true, tokenState: "ok" as const };
const SENDING = { name: "Atlas Reports", username: "atlas_reports_bot", receiving: false, tokenState: "ok" as const };
const chatBot = (over: Record<string, unknown>) => ({ name: MAIN.name, username: MAIN.username, assigned: false, member: true, status: "member", canPost: true, canSendPhotos: true, canSendDocuments: true, canManageTopics: false, reason: null, checkedAt: iso(9), ...over });
const clone = chatBot({ name: "Nova", username: null, clone: { relay: "Celestia" }, status: null, canSendPhotos: false, canSendDocuments: false, reason: null, checkedAt: null });
const chat = (over: Record<string, unknown>) => ({
  chatId: "-1000000000101", title: "Atlas team", type: "supergroup", username: null, isForum: false, member: true, alias: "atlas-team", postAllowed: true, postable: true, seesAllMessages: false, readdToApply: false,
  lastMessageAt: iso(12), lastPostAt: iso(40), lastPostBy: { conversationId: "conv_fixture", title: L("the atlas orchestrator", "оркестратор atlas") }, storedMessages: 12, ...over,
});
const senderOk = { at: iso(40), state: "sent", bot: { name: MAIN.name, username: MAIN.username }, refusals: [] };
const CHATS = () => [
  chat({ bots: [chatBot({}), chatBot({ name: SENDING.name, username: SENDING.username })], lastDelivery: senderOk, isForum: true, seesAllMessages: true, reports: [{ name: "Atlas" }] }),
  chat({ chatId: "-1000000000202", title: L("Atlas support", "Підтримка Atlas"), alias: "atlas-support", bots: [clone, chatBot({ canPost: false, member: false, status: "left", reason: "bot_not_in_chat" })], lastDelivery: null }),
  chat({ chatId: "-1000000000303", title: L("Release notes", "Реліз-нотатки"), alias: "release-notes", readdToApply: true,
    bots: [chatBot({ canPost: false, member: false, status: "kicked", reason: "bot_not_in_chat" })],
    lastDelivery: { at: iso(30), state: "refused", refusals: [{ bot: { name: MAIN.name, username: MAIN.username }, code: "bot_not_in_chat", reason: "", source: "send", at: iso(30) }] },
    reports: [{ name: "Archive", refused: true }] }),
  chat({ chatId: "700000303", title: L("Olena", "Олена"), type: "private", alias: null, postAllowed: false, postable: false, lastPostAt: null, lastPostBy: null, seesAllMessages: true }),
  chat({ chatId: "-1000000000505", title: "Реліз", type: "group", alias: null, postAllowed: false, postable: false, lastPostAt: null, lastPostBy: null }),
  chat({ chatId: "-1000000000606", title: L("Old planning group", "Стара група планування"), member: false, alias: null, postAllowed: false, postable: false, lastPostAt: null, lastPostBy: null }),
];
const LONG_ROOT = "/srv/atlas/customer-documents/reports/2026/quarterly-board-review-materials";
const connected = (over: Record<string, unknown> = {}) => ({
  connected: true, bots: [MAIN, SENDING], bot: { name: MAIN.name, username: MAIN.username, canReadAllGroupMessages: false, canJoinGroups: true }, receiving: "polling",
  lastUpdateAt: iso(2), lastCheckedAt: iso(1), chats: CHATS(), documents: { roots: [LONG_ROOT, "/srv/atlas/pictures/delegatus-review"], custom: true }, limits: [], ...over,
});
const none = { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] };
const SCENES: Record<string, () => Record<string, unknown>> = {
  "telegram-none": () => none,
  "telegram-clone": () => ({ ...none, chats: [chat({ chatId: "-1000000000202", title: L("Atlas support", "Підтримка Atlas"), alias: "atlas-support", bots: [clone], lastDelivery: null, lastPostAt: null, lastPostBy: null }), chat({ chatId: "-1000000000707", title: L("Customer pilots", "Пілоти клієнтів"), alias: "customer-pilots", bots: [clone], lastDelivery: null, lastPostAt: null, lastPostBy: null })] }),
  "telegram-rest": () => connected(),
  "telegram-rejected": () => connected({ receiving: "token_rejected", bots: [{ ...MAIN, tokenState: "rejected" }, SENDING] }),
  "telegram-webhook": () => connected({ receiving: "webhook_elsewhere" }),
  "telegram-sending-rejected": () => connected({ bots: [MAIN, { ...SENDING, tokenState: "rejected" }] }),
  "telegram-nine": () => connected({ bots: [MAIN, ...Array.from({ length: 8 }, (_, at) => ({ ...SENDING, name: `Atlas Sender ${at + 1}`, username: `atlas_sender_${at + 1}_bot` }))] }),
  "telegram-default-folder": () => connected({ documents: { roots: ["/srv/atlas/documents/delegatus"], custom: false } }),
  "telegram-long": () => connected({ bot: { name: "Delegatus Atlas Customer Reports And Releases", username: "atlas_customer_reports_and_releases_bot", canReadAllGroupMessages: true, canJoinGroups: true }, chats: [chat({ title: L("A chat with a very long title that the rows must keep whole in the page's back row", "Чат із дуже довгою назвою, яку рядки мають показати цілою на його сторінці"), bots: [chatBot({})], lastDelivery: senderOk })] }),
};
let bot = (SCENES[SETTINGS_SCENE ?? ""] ?? connected)();
const REPORT_LINES = [
  { project: "atlas", label: "atlas", reportName: "Atlas", reportTelegram: { chat: "atlas-team", name: "Atlas", changedAt: iso(900), changedBy: "operator" } },
  { project: "forge", label: "forge", reportName: null, reportTelegram: null },
  { project: "archive", label: "archive-tools", reportName: "Archive", reportTelegram: { chat: "gone-group", topicId: 7, name: "Archive", changedAt: iso(900), changedBy: "operator" } },
];

/* ---- Voice ---- */
const plan = { type: "pro", limitReached: false, observedAt: NOW - 600_000, primary: { usedPercent: 23, resetsAt: Math.floor(NOW / 1000) + 7_200, windowMinutes: 300 }, secondary: { usedPercent: 62, resetsAt: Math.floor(NOW / 1000) + 3 * 86_400, windowMinutes: 10_080 } };
const voiceBase = { enabled: true, callMemory: true, timerTelegram: false, backend: "codex", monthlyCapUsd: 20, keySource: "file", keyEnvironment: "OPENAI_API_KEY", month: "2026-11", usageUsd: 6.4, reservedUsd: 0, incomplete: false, uncertainSession: false,
  lastSession: { usd: 0.4, seconds: 471, endedAt: NOW - 3_600_000, incomplete: false }, lastCodexSession: { seconds: 252, endedAt: NOW - 3_600_000, plan } };
const VOICE_SCENES: Record<string, Record<string, unknown>> = {
  "voice-off": { enabled: false },
  "voice-codex": {},
  "voice-nocall": { lastCodexSession: undefined },
  "voice-limit": { lastCodexSession: { seconds: 252, endedAt: NOW - 3_600_000, plan: { ...plan, limitReached: true, primary: { ...plan.primary, usedPercent: 100 } } } },
  "voice-file": { backend: "api" },
  "voice-env": { backend: "api", keySource: "env" },
  "voice-missing": { backend: "api", keySource: "missing", usageUsd: 0, lastSession: undefined },
  "voice-near": { backend: "api", usageUsd: 17.2 },
  "voice-reserved": { backend: "api", usageUsd: 6.4, reservedUsd: 1.5 },
  "voice-reached": { backend: "api", usageUsd: 20 },
  "voice-incomplete": { backend: "api", incomplete: true, lastSession: { usd: 0.4, seconds: 471, endedAt: NOW - 3_600_000, incomplete: true } },
  "voice-held": { backend: "codex", requestedBackend: "api", held: true, keySource: "missing" },
  "voice-uncertain": { backend: "api", uncertainSession: true },
  "voice-timer": { timerTelegram: true },
};
const voice: Record<string, unknown> = { ...voiceBase, ...(VOICE_SCENES[SETTINGS_SCENE ?? ""] ?? {}) };

const summary = (over: Record<string, unknown>) => ({ version: 1, state: "final", startedAt: NOW - 3_900_000, endedAt: NOW - 3_600_000, projects: ["atlas"], asked: [L("Review the current layout.", "Перевірити поточний макет.")], done: [], decided: [L("Keep the compact header.", "Лишити компактний заголовок.")], open: [L("Wait for the build report.", "Чекати на звіт збірки.")], privateOmitted: false, through: 10, model: "fixture", durationMs: 1000, inputTokens: 1000, outputTokens: 100, attempts: 1, ...over });
const CALLS = () => params.get("calls") === "empty" ? [] : [
  { sessionId: "c1", summary: summary({ privateOmitted: true }) },
  { sessionId: "c2", summary: summary({ startedAt: NOW - 7_300_000, endedAt: NOW - 7_200_000, decided: [], open: [], done: [L("Opened the deploy log.", "Відкрито журнал викладання.")] }) },
  { sessionId: "c3", summary: summary({ pending: true, asked: [], decided: [], open: [], projects: ["forge"] }) },
  { sessionId: "c4", summary: summary({ state: "failed", code: "account", asked: [], decided: [], open: [], projects: ["forge"] }) },
];
let calls = CALLS();

const digest = (seed: number) => `sha256:${seed.toString(16).padStart(64, "0")}`;
const recipient = `stdio:spotify:sha256:${"a".repeat(64)}`;
const toolCatalog = (count: number) => ({ digest: digest(901), fetchedAt: iso(4), tools: Array.from({ length: count }, (_, at) => ({ name: ["search", "now_playing", "play", "pause", "skip", "queue_add", "queue_clear", "devices", "volume"][at] ?? `tool_${at}`, description: L("Search Spotify for tracks, albums, artists and playlists.", "Шукати в Spotify треки, альбоми, виконавців і плейлисти."), annotations: at < 2 ? { readOnlyHint: true } : undefined })) });
const server = (title: string, capability: string, over: Record<string, unknown>) => ({
  title, capability, private: false, askBeforeActing: false, callTimeoutMs: 15_000, generation: 6, owner: "installation", audience: ["voice"], state: "pending",
  transport: { type: "stdio", command: "uv", args: ["tool", "run", "spotify-mcp-example"], cwd: "/srv/atlas/customer-documents/mcp/spotify", envNames: ["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"], envValues: { SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8888/callback" } },
  entryFile: { path: "spotify_mcp/main.py", sha256: "3f9c".repeat(16) },
  proposedBy: { kind: "conversation", conversationId: "conv_fixture", at: iso(90) }, approval: null, tools: {}, catalog: null, lastDryRun: null, digest: digest(1),
  secretRecipient: recipient, missingSecrets: [], secretRefs: [], secretDestinations: {}, ...over,
});
const music = () => L("Music: play, pause, skip and search in your Spotify.", "Музика: грати, пауза, пропустити й шукати у вашому Spotify.");
const TOOLS = () => ({
  revision: 7,
  servers: {
    "spotify-needs": server("Spotify", music(), { secretRefs: ["spotify-client-id"], missingSecrets: ["spotify-client-id"], secretDestinations: { "spotify-client-id": [] } }),
    "spotify-contained": server("Spotify (macOS)", music(), { lastDryRun: { code: "CONTAINMENT_REQUIRED", at: iso(40), digest: digest(503), runId: digest(700), containmentReason: "MACOS" } }),
    "spotify-passed": server("Spotify (passed)", music(), { catalog: toolCatalog(5), lastDryRun: { code: "OK", at: iso(4), digest: digest(501) }, tools: { search: { enabled: true, acts: false }, play: { enabled: true, acts: true } } }),
    "calendar": server(L("Calendar", "Календар"), L("Reads today's events", "Читає події на сьогодні"), { state: "enabled", catalog: toolCatalog(9), lastDryRun: { code: "OK", at: iso(400), digest: digest(502) }, tools: { search: { enabled: true, acts: false } }, askBeforeActing: true,
      transport: { type: "http", url: "https://calendar.example.org/mcp", headerNames: ["Authorization", "X-Team"], headerValues: { "X-Team": "atlas" } }, entryFile: null }),
    "notes": server(L("Notes", "Нотатки"), L("Reads and adds notes", "Читає й додає нотатки"), { state: "changed", catalog: toolCatalog(3), lastDryRun: { code: "ENTRY_CHANGED", at: iso(10), digest: digest(504) } }),
    "drive": server(L("Drive", "Диск"), L("Reads shared files", "Читає спільні файли"), { state: "rejected" }),
    "tracker": server(L("Tracker", "Трекер"), L("Reads tasks", "Читає задачі"), { state: "disabled", catalog: toolCatalog(2), lastDryRun: { code: "OK", at: iso(500), digest: digest(505) } }),
  },
});
let tools = TOOLS() as { revision: number; servers: Record<string, Record<string, unknown>> };
if (SETTINGS_SCENE === "voice-tools-empty") tools = { revision: 1, servers: {} };
if (SETTINGS_SCENE === "voice-tools-one") tools = { ...tools, servers: { drive: tools.servers.drive! } };

/* What the OpenAI key can serve (GET /api/openai-services): each feature's choices, OpenAI last, as the policy lists them. */
const keyed = voice.keySource !== "missing";
const feature = (name: string, effective: string, ids: string[], over: Record<string, unknown> = {}) => ({
  feature: name, requested: effective, effective, held: false, available: true, lockedBy: null,
  options: ids.map((id) => ({ id, available: id === "openai" || id === "api" ? keyed : id !== "soniox" })), ...over,
});
let services = [
  feature("asks", "openrouter", ["openrouter", "openai"]),
  feature("memory", "openrouter", ["openrouter", "openai"]),
  feature("rules", "openrouter", ["openrouter", "openai"]),
  feature("dictation", "chatgpt", ["local", "chatgpt", "elevenlabs", "soniox", "openai"]),
  feature("read", "elevenlabs", ["elevenlabs", "soniox", "fishaudio", "openai"]),
  feature("voice", String(voice.backend === "api" ? "api" : "codex"), ["codex", "api"]),
];

const KEYS = () => ({ staging: false, owner: true, keys: [
  { id: "openrouter", variable: "OPENROUTER_API_KEY", source: "missing", masked: null },
  { id: "openai", variable: "OPENAI_API_KEY", source: voice.keySource, masked: voice.keySource === "missing" ? null : "sk-proj-••••••••2222" },
  { id: "elevenlabs", variable: "ELEVENLABS_API_KEY", source: "missing", masked: null },
  { id: "soniox", variable: "SONIOX_API_KEY", source: "missing", masked: null },
  { id: "fishaudio", variable: "FISH_AUDIO_API_KEY", source: "missing", masked: null },
  { id: "telegram", variable: "DELEGATUS_TELEGRAM_BOT_TOKEN", source: bot.connected ? "file" : "missing", masked: bot.connected ? "1234••••wxyz" : null },
] });

/** The window's routes for this scene; null leaves a route to the fixture. */
export async function settingsEvidenceRoute(url: URL, method: string, init?: RequestInit): Promise<Response | null> {
  if (!SETTINGS_SCENE) return null;
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  const write = method !== "GET";
  if (url.pathname === "/api/telemetry") {
    if (write && REFUSE) return json({ error: "read-only" }, 500);
    if (write) Object.assign(telemetry, body);
    return json(telemetry);
  }
  if (url.pathname === "/api/subscription-api-consent") {
    if (SETTINGS_SCENE === "privacy-consent-failed") return json({}, 500);
    if (write && REFUSE) return json({}, 403);
    if (write) consent = body.enabled === true;
    return json({ enabled: consent, source: "stored" });
  }
  if (url.pathname === "/api/telegram/bot") {
    if (write && REFUSE) return json({ code: body.action === "test" ? "forbidden" : "storage_unsafe" }, 400);
    const action = body.action;
    if (action === "chat") bot = { ...bot, chats: (bot.chats as Record<string, unknown>[]).map((row) => row.chatId === body.chatId ? { ...row, alias: body.alias || null, postAllowed: body.postAllowed, postable: Boolean(body.postAllowed && body.alias && row.member) } : row) };
    if (action === "chat_bot") bot = { ...bot, chats: (bot.chats as Record<string, unknown>[]).map((row) => row.chatId === body.chatId ? { ...row, assignedBot: body.bot } : row) };
    if (action === "documents") bot = { ...bot, documents: (body.roots as string[]).length ? { roots: body.roots, custom: true } : { roots: ["/srv/atlas/documents/delegatus"], custom: false } };
    if (action === "remove_bot") bot = { ...bot, bots: (bot.bots as { username: string }[]).filter((row) => row.username !== body.bot) };
    if (action === "add_bot") bot = { ...bot, bots: [...(bot.bots as object[]), { name: "Atlas Pilot", username: "atlas_pilot_bot", receiving: false, tokenState: "ok" }] };
    if (action === "remove") bot = none;
    if (action === "add") {
      bot = { ...bot, chats: [...(bot.chats as object[]), chat({ chatId: "-1000000000808", title: L("Customer pilots", "Пілоти клієнтів"), alias: "customer-pilots", lastPostAt: null, lastPostBy: null })] };
      return json({ bot, added: { chat: "customer-pilots" } });
    }
    return json({ bot });
  }
  if (url.pathname === "/api/projects/reports") return json({ projects: REPORT_LINES });
  if (url.pathname === "/api/projects/settings" && write) {
    const choice = body.reportTelegram as { link?: string } | null;
    if (choice?.link?.includes("bad")) return json({ message: L("That link names no chat this bot can reach.", "Це посилання не веде до чату, доступного цьому боту.") }, 400);
    return REFUSE ? json({}, 500) : json({ ok: true });
  }
  if (url.pathname === "/api/voice-companion/settings") {
    if (write && REFUSE) return json({ code: "COMPANION_UNAVAILABLE" }, 503);
    if (write) { Object.assign(voice, body); if (body.backend) delete voice.held; if (body.releaseUncertainSession) voice.uncertainSession = false; }
    return json(voice);
  }
  if (url.pathname === "/api/voice-companion/memory") {
    if (SETTINGS_SCENE === "voice-memory-error") return json({}, 500);
    if (method === "DELETE") calls = body.all ? [] : calls.filter((row) => row.sessionId !== body.sessionId);
    return json({ calls, retained: calls.length });
  }
  if (url.pathname === "/api/voice-tools") {
    if (SETTINGS_SCENE === "voice-tools-error") return json({}, 500);
    if (SETTINGS_SCENE === "voice-tools-signin") return json({ code: "OPERATOR_REQUIRED" }, 401);
    if (write && REFUSE) return json({ code: "STALE_APPROVAL" }, 409);
    if (body.action === "remove") tools = { ...tools, servers: Object.fromEntries(Object.entries(tools.servers).filter(([name]) => name !== body.name)) };
    return json(tools);
  }
  if (url.pathname === "/api/keys") return json(KEYS());
  if (url.pathname === "/api/openai-services") {
    if (write && REFUSE) return json({}, 500);
    if (write) services = services.map((state) => state.feature === body.feature ? { ...state, requested: String(body.provider), effective: String(body.provider), held: false } : state);
    return json({ openaiKey: voice.keySource, features: services });
  }
  if (url.pathname === "/api/memory/settings") return json({ enabled: true, reasons: [], capUsd: 5, spentUsd: 1.2, month: "2026-11", counts: { delivered: 8, decisions: 12 } });
  if (url.pathname === "/api/operator/worker-limit") return json({ machine: { value: 12 }, project: { key: "atlas", value: null, effective: 12, source: "machine" }, running: { here: 2, machine: 5 } });
  return null;
}
