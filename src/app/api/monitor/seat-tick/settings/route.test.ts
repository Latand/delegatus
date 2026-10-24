import { afterAll, afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

/*
 * The browser's seat tick settings route (#1681).
 *
 * Two things are being held here, and neither is a rule of its own:
 *
 * - **Parity with the tool.** Every refusal comes from
 *   `applySeatTickSettingsChange` in its own words, and the answer's
 *   `settings` and `effective` are compared field for field against what the
 *   `seat_tick_settings` tool answers over the SAME sandboxed file. A rule
 *   this route enforced itself would show up here as a disagreement.
 * - **Attribution, not prohibition.** A browser request records as `gateway`,
 *   the target project's own seat as `manager` with its epoch, any other
 *   identified caller as `agent`. Nothing in the body can name who made a
 *   change, and nobody is refused.
 *
 * Every request reads and writes files inside a sandbox; the operator's live
 * state is never touched.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-settings-route-"));
const RESTORE = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TMPDIR: process.env.TMPDIR,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_SEAT_TICK_SETTINGS_FILE: process.env.LLV_SEAT_TICK_SETTINGS_FILE,
  LLV_SEAT_TICK_STATE_FILE: process.env.LLV_SEAT_TICK_STATE_FILE,
  LLV_SEAT_TICK_AUDIT_FILE: process.env.LLV_SEAT_TICK_AUDIT_FILE,
  LLV_RUNTIME_HOST_SOCKET: process.env.LLV_RUNTIME_HOST_SOCKET,
  LLV_CODEX_HOME: process.env.LLV_CODEX_HOME,
};
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "codex");
/* A Viewer-spawned session inherits the live runtime host's socket; nothing
   here may reach outside this process. */
delete process.env.LLV_RUNTIME_HOST_SOCKET;
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const { GET, PUT } = await import("./route");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { appendSeatTickRecord } = await import("@/lib/monitor/journalStore");
const { readSeatTickSettings, readSeatTickSettingsFile, writeSeatTickSettings, SEAT_TICK_PROMPT_LIMIT, SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES } = await import("@/lib/monitor/seatTickSettings");
const { readStateCollectionRevision } = await import("@/lib/state/sqliteStateStore");
const { writeSeatTickState } = await import("@/lib/monitor/seatTickState");
const { emptySeatTickState } = await import("@/lib/monitor/types");
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import type { SeatTickRunRecord } from "@/lib/monitor/types";

const PROJECT = "viewer";
/** A 43-character capability is the only shape the resolver is asked about. */
const CAPABILITY = "c".repeat(43);
const SEAT_CONVERSATION = "conversation_seat_of_viewer";
const OTHER_CONVERSATION = "conversation_some_worker";
const OTHER_PROJECT = "other-project";

let settingsFile = "";

/* The settings live in the `state.sqlite` beside the legacy path (#1870
   slice 5); a read may import the (absent) file, which writes no row. */
const settingsRevision = () => readStateCollectionRevision(path.join(path.dirname(settingsFile), "state.sqlite"), "seat_tick_settings");
function expectNothingStored(): void {
  expect(readSeatTickSettingsFile(settingsFile)).toEqual({});
  expect(settingsRevision() ?? 0).toBe(0);
}

beforeEach(() => {
  const id = crypto.randomUUID();
  /* Its own directory: the settings live in the `state.sqlite` beside it. */
  settingsFile = path.join(SANDBOX, "settings", id, "seat-tick-settings.json");
  process.env.LLV_SEAT_TICK_SETTINGS_FILE = settingsFile;
  /* The active tick file uses its directory's state.sqlite, regardless of
     its basename. A distinct filename alone shares the previous case's row. */
  process.env.LLV_SEAT_TICK_STATE_FILE = path.join(SANDBOX, "state", id, "tick.json");
  process.env.LLV_SEAT_TICK_AUDIT_FILE = path.join(SANDBOX, "journal", `${id}.ndjson`);
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"), { force: true });
});
afterEach(() => { setCallerConversationResolverForTests(null); setSystemTime(); });
afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const URL_BASE = "http://127.0.0.1:8898/api/monitor/seat-tick/settings";
/** What the Viewer's own page sends. */
const browser = { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", "sec-fetch-site": "same-origin", "content-type": "application/json" };

const get = (query: string, headers: Record<string, string> = { host: "127.0.0.1:8898" }) =>
  GET(new NextRequest(`${URL_BASE}${query}`, { headers }));
const put = (body: unknown, headers: Record<string, string> = browser) =>
  PUT(new NextRequest(URL_BASE, { method: "PUT", headers, body: JSON.stringify(body) }));

test("Turbo paid credits require the separate operator-browser approval; script, worker and seat claims cannot grant it", async () => {
  const body = { project: PROJECT, turbo: { enabled: true, hours: 2, credits: true, creditAccounts: ["default"] } };
  const script = await put(body, { host: "127.0.0.1:8898", "content-type": "application/json" });
  expect(script.status).toBe(403);
  expect((await script.json()).error).toContain("operator's own browser");
  for (const conversationId of [OTHER_CONVERSATION, SEAT_CONVERSATION]) {
    setCallerConversationResolverForTests(() => conversationId);
    const response = await put(body, { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("operator's own browser");
  }
  setCallerConversationResolverForTests(() => null);
  expect((await put(body, { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "unrecognised" })).status).toBe(403);
  expectNothingStored();
});

test("Turbo cannot be enabled by an anonymous script even without paid credits", async () => {
  const response = await put({ project: PROJECT, turbo: { enabled: true, hours: 2 } }, { host: "127.0.0.1:8898", "content-type": "application/json" });
  expect(response.status).toBe(403);
  expectNothingStored();
});

test.each([{ change: { enabled: false }, active: false }, { change: { credits: false }, active: true }])("Turbo revocation ignores unreadable account bindings: %j", async ({ change, active }) => {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "turbo-revocation-"));
  setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
  try {
    const { applySeatTickSettingsChange, defaultSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
    const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
    const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
    const { allowedAccountIdsForProject } = await import("@/lib/accounts/projectBindings");
    const seeded = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { turbo: { enabled: true, hours: 2, credits: true, creditAccounts: ["acct-a"] } }, {
      at: new Date().toISOString(), actor: { kind: "gateway", project: null, conversationId: null, seatEpoch: null },
      turbo: { allowedAccounts: ["acct-a"], plan: [{ accountId: "acct-a", label: "Account A", plan: "pro", tiers: { "gpt-6.1-sol": "priority" }, hadCredits: true }] },
    });
    if (!seeded.ok) throw new Error(seeded.error);
    writeSeatTickSettings(PROJECT, seeded.settings);
    seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "codex" }] });
    expect(() => allowedAccountIdsForProject(PROJECT, "codex")).toThrow("unreadable");
    const response = await put({ project: PROJECT, turbo: change });
    expect(response.status).toBe(200);
    expect((await response.json()).turbo).toMatchObject({ active, episode: { credits: { approved: false } } });
    expect(readSeatTickSettings(PROJECT).turbo?.credits.approved).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
});

test("Turbo operator confirmation stores a separate finite paid approval and off withdraws it", async () => {
  const home = fs.mkdtempSync(path.join(SANDBOX, "turbo-catalog-"));
  const previous = process.env.LLV_CODEX_HOME;
  process.env.LLV_CODEX_HOME = home;
  try {
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }] }] }));
    const response = await put({ project: PROJECT, turbo: { enabled: true, hours: 2, credits: true, creditAccounts: ["default"] } });
    expect(response.status).toBe(200);
    expect((await response.json()).turbo).toMatchObject({ active: true, episode: { credits: { approved: true, accounts: ["default"] } } });
    const invalid = await put({ project: PROJECT, turbo: { hours: null, credits: true, creditAccounts: ["default"] } });
    expect(invalid.status).toBe(400);
    const off = await put({ project: PROJECT, turbo: { enabled: false } });
    expect(off.status).toBe(200);
    expect((await off.json()).turbo).toMatchObject({ active: false, episode: { credits: { approved: false } } });
  } finally {
    if (previous === undefined) delete process.env.LLV_CODEX_HOME; else process.env.LLV_CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("proactive enable requires the operator browser and returns persisted effective permission", async () => {
  setSystemTime(new Date("2026-10-22T00:00:00.000Z"));
  const autonomy = { enabled: true, proactive: { enabled: true } };
  for (const headers of [
    { host: "127.0.0.1:8898", "content-type": "application/json" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  ]) {
    const refused = await put({ project: PROJECT, autonomy, actor: { kind: "gateway" } }, headers);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("only the operator browser");
    expectNothingStored();
  }
  const saved = await put({ project: PROJECT, autonomy });
  expect(saved.status).toBe(200);
  expect((await saved.json()).autonomy.proactive).toEqual({ enabled: true });
  expect((await (await get(`?project=${PROJECT}`)).json()).autonomy.proactive).toEqual({ enabled: true });
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  setCallerConversationResolverForTests(() => SEAT_CONVERSATION);
  const stopped = await put({ project: PROJECT, autonomy: { proactive: { enabled: false }, why: "Stop discovery" } }, { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY });
  expect(stopped.status).toBe(200);
  expect((await stopped.json()).autonomy).toMatchObject({ active: true, proactive: { enabled: false } });
});

test("HTTP and seat_tick_settings report maintenance paused while wakes are off", async () => {
  const written = await put({ project: PROJECT, enabled: false, reason: "fixture pause", maintenance: { enabled: true, intervalHours: 3 } });
  expect(written.status).toBe(200);
  const http = await written.json() as SeatTickSettingsAnswer;
  expect(http.maintenance).toMatchObject({ enabled: true, waitingOn: "wakes-off", pauseReason: "paused while wakes are off", nextRunAt: null, nextEligibleAt: null });
  const tool = await viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: null }), callerProject: () => PROJECT, authorizedSeats: () => [{ project: PROJECT, conversationId: SEAT_CONVERSATION, path: null }],
  } as never).seat_tick_settings({ clientRequestId: "fixture-paused-maintenance-read", project: PROJECT });
  expect(tool.maintenance).toMatchObject(http.maintenance);
});

/** The active seats attribution is measured against: which conversation holds
    the target project's seat, and which holds another project's. */
function seatFile(...held: Array<{ project: string; conversationId: string; seatEpoch: number }>): void {
  const seats = Object.fromEntries(held.map((entry) => [entry.project, {
    project: entry.project,
    seatEpoch: entry.seatEpoch,
    conversationId: entry.conversationId,
    path: null,
    mandate: "run the board",
    state: "active",
    intent: { clientRequestId: `req-seat-${entry.project}`, mode: "spawn", launchId: null, error: null },
    designatedAt: "2026-09-18T08:00:00.000Z",
    activatedAt: "2026-09-18T08:00:01.000Z",
  }]));
  fs.writeFileSync(
    path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"),
    JSON.stringify({
      schemaVersion: 1,
      nextSeatEpoch: Math.max(...held.map((entry) => entry.seatEpoch)) + 1,
      seats,
      pending: {},
      revocations: [],
      history: [],
    }),
    "utf8",
  );
}

function record(at: string, verdict: SeatTickRunRecord["verdict"], outcome: string | null, detail: string | null = null): SeatTickRunRecord {
  return {
    schemaVersion: 1,
    at,
    project: PROJECT,
    seatEpoch: 7,
    verdict,
    reasons: verdict === "wake" ? ["interval"] : [],
    items: 0,
    deferred: 0,
    eventsThrough: 3,
    delivery: outcome ? { clientMessageId: `seat-tick:${PROJECT}:7:k:interval:fp`, outcome } : null,
    detail,
  };
}

test("a read needs a project, answers the defaults for a project nobody configured, and writes nothing", async () => {
  expect((await get("")).status).toBe(400);
  const response = await get(`?project=${PROJECT}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as SeatTickSettingsAnswer;
  expect(body).toMatchObject({
    project: PROJECT,
    changed: false,
    settings: { enabled: true, wakeIntervalMinutes: null, reason: null, until: null, updatedAt: null, setBy: null },
    effective: { enabled: true, wakeIntervalMinutes: 60, isDefault: true, configured: false },
    defaultWakeIntervalMinutes: 60,
    cardText: null,
  });
  /* Unknown, not quiet: the tick has recorded nothing for this name. */
  expect(body.state).toBeNull();
  expect(body.stateError).toBeNull();
  expect(body.lastRun).toBeNull();
  expect(body.lastDelivery).toBeNull();
  expect(body.policy).toMatchObject({ checkIntervalMinutes: 5, staleAfterMinutes: 15 });
  expectNothingStored();
});

test("a browser change records as the operator's own session, whatever the body claims, and the answer is the stored record", async () => {
  const response = await put({
    project: PROJECT,
    wakeIntervalMinutes: 30,
    reason: "a busy afternoon",
    /* None of these may reach the row: attribution is the route's. */
    setBy: { kind: "manager", conversationId: OTHER_CONVERSATION, project: "elsewhere" },
    actor: { kind: "manager" },
    conversationId: OTHER_CONVERSATION,
  });
  expect(response.status).toBe(200);
  const body = await response.json() as SeatTickSettingsAnswer;
  const stored = readSeatTickSettings(PROJECT, settingsFile);
  expect(stored).toMatchObject({
    wakeIntervalMinutes: 30,
    reason: "a busy afternoon",
    setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
  });
  expect(body.changed).toBe(true);
  expect(body.settings).toEqual(stored);
  expect(body.effective).toMatchObject({ wakeIntervalMinutes: 30, reason: "a busy afternoon", isDefault: false, configured: true });
  expect(body.actor).toEqual({ kind: "gateway", conversationId: null, project: null, seatEpoch: null });
  /* Read back, not echoed: a later GET answers the same record. */
  const read = await (await get(`?project=${PROJECT}`)).json() as SeatTickSettingsAnswer;
  expect(read.settings).toEqual(stored);
  expect(read.changed).toBe(false);
});

test("the target project's own seat records as the manager with its epoch; any other identified caller records as an agent", async () => {
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  setCallerConversationResolverForTests(() => SEAT_CONVERSATION);
  const managed = await (await put(
    { project: PROJECT, enabled: false, reason: "nothing to do until the release lands" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  )).json() as SeatTickSettingsAnswer;
  expect(managed.actor).toEqual({ kind: "manager", conversationId: SEAT_CONVERSATION, project: PROJECT, seatEpoch: 12 });
  expect(readSeatTickSettings(PROJECT, settingsFile).setBy).toMatchObject({ kind: "manager", seatEpoch: 12 });

  setCallerConversationResolverForTests(() => OTHER_CONVERSATION);
  const agent = await (await put(
    { project: PROJECT, wakeIntervalMinutes: 15, reason: "a worker slowing another project's tick" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  )).json() as SeatTickSettingsAnswer;
  /* Allowed, and named: a control is a capability, and attribution answers. */
  expect(agent.actor).toEqual({ kind: "agent", conversationId: OTHER_CONVERSATION, project: null, seatEpoch: null });
  expect(readSeatTickSettings(PROJECT, settingsFile)).toMatchObject({
    wakeIntervalMinutes: 15,
    setBy: { kind: "agent", conversationId: OTHER_CONVERSATION, project: null },
  });
});

test("a seat changing ANOTHER project's tick carries its own project, so the board card can name the foreign change", async () => {
  /* The card's «whose own project is X» clause (`seatTickSettingsCardText`) is
     the whole reason a foreign change is attributed rather than refused, and
     it reads `setBy.project`. The MCP tool carries the caller's own project
     there; the route has to agree, or the same change made over HTTP produces
     a card that names the actor and not its project. */
  seatFile(
    { project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 },
    { project: OTHER_PROJECT, conversationId: OTHER_CONVERSATION, seatEpoch: 3 },
  );
  setCallerConversationResolverForTests(() => OTHER_CONVERSATION);
  const body = await (await put(
    { project: PROJECT, wakeIntervalMinutes: 15, reason: "quieting a neighbour while its release runs" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  )).json() as SeatTickSettingsAnswer;

  expect(body.actor).toEqual({ kind: "agent", conversationId: OTHER_CONVERSATION, project: OTHER_PROJECT, seatEpoch: null });
  /* It holds no seat HERE, so no epoch is claimed for this project. */
  expect(readSeatTickSettings(PROJECT, settingsFile).setBy).toEqual({
    kind: "agent",
    conversationId: OTHER_CONVERSATION,
    project: OTHER_PROJECT,
    seatEpoch: null,
  });
  expect(body.cardText).toContain(`чий власний проєкт — ${OTHER_PROJECT}`);
});

test("an identified caller that holds no seat and owns no project names none, rather than inventing one", async () => {
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  setCallerConversationResolverForTests(() => OTHER_CONVERSATION);
  const body = await (await put(
    { project: PROJECT, enabled: false, reason: "a worker quieting a project it has no claim on" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  )).json() as SeatTickSettingsAnswer;
  expect(body.actor).toEqual({ kind: "agent", conversationId: OTHER_CONVERSATION, project: null, seatEpoch: null });
  expect(body.cardText).toContain("Змінив(ла): сесія агента");
  expect(body.cardText).not.toContain("whose own project is");
});

test("the module's rules hold verbatim, and a refusal stores nothing", async () => {
  const refusals = [
    [{ project: PROJECT, enabled: false }, "instructions (reason) are required when the tick is disabled or its wake interval changes"],
    [{ project: PROJECT, wakeIntervalMinutes: -5, reason: "why" }, "wakeIntervalMinutes must be a positive number of minutes, or null for the default"],
    [{ project: PROJECT, wakeIntervalMinutes: SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES + 1, reason: "far too long" }, `must be at most ${SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES}`],
    [{ project: PROJECT, monitorPrompt: "x".repeat(SEAT_TICK_PROMPT_LIMIT + 1) }, `the limit is ${SEAT_TICK_PROMPT_LIMIT}`],
    [{ project: PROJECT, enabled: false, reason: "quiet", untilMinutes: 0 }, "untilMinutes must be a positive number of minutes"],
    [{ enabled: false, reason: "no project named" }, "project is required"],
  ] as const;
  for (const [body, message] of refusals) {
    const response = await put(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
  }
  /* Nothing stored: no row, and the collection never moved past its import. */
  expectNothingStored();
});

test("an expiry, and restoring the default with no reason, go through the same record", async () => {
  await put({ project: PROJECT, enabled: false, reason: "a deploy is running", untilMinutes: 90 });
  const off = readSeatTickSettings(PROJECT, settingsFile);
  expect(off.enabled).toBe(false);
  expect(Date.parse(off.until!) - Date.now()).toBeGreaterThan(89 * 60_000);
  const before = settingsRevision();

  const restored = await (await put({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null })).json() as SeatTickSettingsAnswer;
  expect(restored.changed).toBe(true);
  expect(restored.effective).toMatchObject({ isDefault: true, enabled: true, reason: "a deploy is running", until: null });
  expect(restored.cardText).toBeNull();
  expect(readSeatTickSettings(PROJECT, settingsFile)).toMatchObject({ enabled: true, wakeIntervalMinutes: null, reason: "a deploy is running", until: null });
  expect(settingsRevision()).toBeGreaterThan(before!);
});

test("PUT and GET retain default-cadence instructions, and clearing them preserves the seat note", async () => {
  const reason = "Handle the incoming tasks by priority.";
  const monitorPrompt = "Track the active lanes.";
  const saved = await put({ project: PROJECT, reason, monitorPrompt });
  expect(saved.status).toBe(200);
  expect((await saved.json()).settings).toMatchObject({ reason, monitorPrompt, wakeIntervalMinutes: null });
  const read = await GET(new NextRequest(`http://localhost/api/monitor/seat-tick/settings?project=${PROJECT}`));
  expect((await read.json()).settings).toMatchObject({ reason, monitorPrompt });
  const cleared = await put({ project: PROJECT, reason: null });
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).settings).toMatchObject({ reason: null, monitorPrompt });
  expect(readSeatTickSettings(PROJECT, settingsFile)).toMatchObject({ reason: null, monitorPrompt });
});

test("a change with no fields is a read, as the tool's is", async () => {
  const response = await put({ project: PROJECT });
  expect(response.status).toBe(200);
  const body = await response.json() as SeatTickSettingsAnswer;
  expect(body.changed).toBe(false);
  expect(body.settings.setBy).toBeNull();
  expectNothingStored();
});

test("a write from anything but the Viewer's own origin is refused before the body is read", async () => {
  const crossSite = await put({ project: PROJECT, enabled: false, reason: "from elsewhere" }, { ...browser, origin: "http://example.test", "sec-fetch-site": "cross-site" });
  expect(crossSite.status).toBe(403);
  expect((await crossSite.json()).error).toContain("cross-origin");
  expectNothingStored();
});

test("the actual state is the tick's own record and the journal, with the dispatch token never leaving the server", async () => {
  writeSeatTickState(PROJECT, {
    ...emptySeatTickState(),
    seatEpoch: 7,
    lastCheckAt: "2026-09-18T09:00:00.000Z",
    lastWakeAt: "2026-09-18T08:00:00.000Z",
    lastWakeReasons: ["interval", "stalled"],
    wakesWithoutChange: { interval: 3, stalled: 3 },
    eventsThrough: 3,
    outstandingWake: {
      clientMessageId: "seat-tick:viewer:7:k:interval:fp",
      conversationId: SEAT_CONVERSATION,
      seatEpoch: 7,
      operationId: null,
      commit: { proposal: false, reasons: ["interval"], fingerprint: "fp", eventsThrough: 3, children: [] },
      preparedAt: "2026-09-18T08:00:01.000Z",
      dispatch: { token: "DISPATCH-TOKEN-SENTINEL", state: "refused" },
    },
    pullRequestGap: { gap: "command-failed", since: "2026-09-17T08:00:00.000Z", lastAttemptAt: "2026-09-18T09:00:00.000Z", attempts: 4, reported: true },
  });
  appendSeatTickRecord(record("2026-09-18T08:00:00.000Z", "wake", "landed"));
  appendSeatTickRecord(record("2026-09-18T09:00:00.000Z", "quiet", null, "nothing owed"));

  const body = await (await get(`?project=${PROJECT}`)).json() as SeatTickSettingsAnswer;
  expect(body.state).toMatchObject({
    lastCheckAt: "2026-09-18T09:00:00.000Z",
    lastWakeAt: "2026-09-18T08:00:00.000Z",
    lastWakeReasons: ["interval", "stalled"],
    outstandingWake: { preparedAt: "2026-09-18T08:00:01.000Z", dispatch: "refused" },
    retryGuard: [{ kind: "stalled", wakes: 3 }],
    sourceGap: { source: "pull-requests", gap: "command-failed", since: "2026-09-17T08:00:00.000Z" },
  });
  /* The newest CHECK, and separately the newest check that sent something:
     the last delivery read off a quiet check would report none. */
  expect(body.lastRun).toMatchObject({ at: "2026-09-18T09:00:00.000Z", verdict: "quiet", detail: "nothing owed" });
  expect(body.lastDelivery).toEqual({ at: "2026-09-18T08:00:00.000Z", outcome: "landed" });
  expect(JSON.stringify(body)).not.toContain("DISPATCH-TOKEN-SENTINEL");
});

test("the answer agrees with the seat_tick_settings tool over the same record", async () => {
  writeSeatTickSettings(PROJECT, {
    project: PROJECT,
    enabled: true,
    wakeIntervalMinutes: 240,
    reason: "slow it down over the weekend",
    monitorPrompt: "Look at the release lane first.",
    until: null,
    updatedAt: "2026-09-18T07:00:00.000Z",
    setBy: { kind: "agent", conversationId: OTHER_CONVERSATION, project: null, seatEpoch: null },
  }, settingsFile);

  const body = await (await get(`?project=${PROJECT}`)).json() as SeatTickSettingsAnswer;
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: null }),
    authorizedSeats: () => [{ project: PROJECT, conversationId: SEAT_CONVERSATION, path: null }],
    callerProject: () => PROJECT,
    readTickSettings: (project: string) => readSeatTickSettings(project, settingsFile),
  } as never);
  /* The tool's full read carries the note once, at the top level (#2030); the
     browser control reads it inside both records. */
  const tool = await bindings.seat_tick_settings({ clientRequestId: "tick-parity", project: PROJECT, verbose: true }) as unknown as {
    settings: Omit<SeatTickSettingsAnswer["settings"], "monitorPrompt">;
    monitorPrompt: string | null;
    effective: Record<string, unknown>;
    defaultWakeIntervalMinutes: number;
    monitorPromptLength: number;
  };
  expect(body.settings).toEqual({ ...tool.settings, monitorPrompt: tool.monitorPrompt });
  expect(body.defaultWakeIntervalMinutes).toBe(tool.defaultWakeIntervalMinutes);
  expect(body.monitorPromptLength).toBe(tool.monitorPromptLength);
  for (const field of ["enabled", "wakeIntervalMinutes", "reason", "until", "isDefault"] as const) {
    expect(body.effective[field] as unknown, field).toEqual(tool.effective[field]);
  }
  expect(body.effective.monitorPrompt).toBe(tool.monitorPrompt);
  /* The card the board carries while this stands, in the card's own words. */
  /* No operator language is recorded in this sandbox, so the card is in the
     default Ukrainian, and its first line is the setting itself. */
  expect(body.cardText?.split("\n")[0]).toBe("Тікер: кожні 4 год");
  expect(body.cardText).toContain("Пробудження цього проєкту йдуть кожні 4 год");
  expect(body.cardText).toContain("slow it down over the weekend");
});


test("maintenance-only write needs no reason and exposes the same run records through HTTP and MCP", async () => {
  const project = "fixture-maintenance-route";
  const written = await put({ project, maintenance: { enabled: true, intervalHours: "200" } });
  expect(written.status).toBe(200);
  const answer = await written.json();
  expect(answer.maintenance).toMatchObject({ enabled: true, intervalHours: 168, lastRun: null, runsError: null });
  const { claimMaintenanceRun, patchMaintenanceRun } = await import("@/lib/boardMaintenance/store");
  const result = claimMaintenanceRun({ project, now: Date.now(), intervalHours: 168, seat: { seatEpoch: 1, conversationId: "fixture-seat" }, repoDir: "/fixtures/repository" });
  if (!result.claimed) throw new Error(result.reason);
  patchMaintenanceRun(result.run.runId, { state: "failed", launchedAt: result.run.claimedAt, endedAt: new Date().toISOString(), taskId: "fixture-card", failure: { kind: "no-account", detail: "fixture reason" }, log: { ...result.run.log, leftAlone: [{ taskId: "aabbccdd", reason: "open lane" }] } });
  const http = await (await get(`?project=${project}`)).json();
  expect(http.maintenance.lastRun).toMatchObject({ taskId: "fixture-card", state: "failed", failure: { kind: "no-account" } });
  const tool = await viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: null }), callerProject: () => project, authorizedSeats: () => [{ project, conversationId: SEAT_CONVERSATION, path: null }],
  } as never).seat_tick_settings({ clientRequestId: "fixture-maintenance-read", project, verbose: true });
  const same = { ...http.maintenance };
  delete same.nextRunAt;
  expect(tool.maintenance).toMatchObject({ ...same, lastRunLog: { leftAlone: [{ taskId: "aabbccdd", reason: "open lane" }] } });
});

test("the browser can enable automatic rotation without a why and records gateway attribution", async () => {
  const response = await put({ project: PROJECT, autoRotate: { enabled: true, thresholdPercent: 60 } });
  expect(response.status).toBe(200);
  const answer = await response.json() as SeatTickSettingsAnswer;
  expect(answer.autoRotate).toMatchObject({ enabled: true, thresholdPercent: 60, defaultPercent: 50, minPercent: 50, maxPercent: 90, why: null, setBy: { kind: "gateway" } });
  expect(readSeatTickSettings(PROJECT).autoRotate).toMatchObject({ enabled: true, thresholdPercent: 60, why: null, setBy: { kind: "gateway" } });
});


test("curation has its own bounded timer, HTTP/MCP parity and no maintenance cascade", async () => {
  const project = "fixture-curation-route";
  const initial = await (await get(`?project=${project}`)).json();
  expect(initial.curation).toMatchObject({ enabled: true, intervalHours: 6, lastRun: null });
  const written = await put({ project, curation: { enabled: false, intervalHours: "200" } });
  expect(written.status).toBe(200);
  const http = await written.json();
  expect(http.curation).toMatchObject({ enabled: false, intervalHours: 168, nextRunAt: null, waitingOn: "off" });
  expect(http.maintenance).toMatchObject({ enabled: false, intervalHours: 3 });
  const api = viewerMcpBindings(undefined, undefined, { callerProject: () => project, callerAttribution: () => ({ kind: "gateway", conversationId: null }), authorizedSeats: () => [] } as never);
  const tool = await api.seat_tick_settings({ clientRequestId: "curation-read", verbose: true });
  expect(tool.curation).toEqual(http.curation);
  await api.seat_tick_settings({ clientRequestId: "curation-change", curation: { enabled: true, intervalHours: null } });
  expect((await (await get(`?project=${project}`)).json()).curation).toMatchObject({ enabled: true, intervalHours: 6 });
  await put({ project, curation: { intervalHours: -2 } });
  expect(readSeatTickSettings(project).curation?.intervalHours).toBe(1);
  const before = readSeatTickSettings(project);
  expect((await put({ project, curation: { enabled: "yes" } })).status).toBe(400);
  expect(readSeatTickSettings(project)).toEqual(before);
  await put({ project, curation: { intervalHours: "1e400" } });
  expect(readSeatTickSettings(project).curation?.intervalHours).toBe(1);
  await put({ project, enabled: false, reason: "fixture", untilMinutes: 1 });
  const { effectiveSeatTickSettings, seatTickSettingsAfterLapse } = await import("@/lib/monitor/seatTickSettings");
  const stored = readSeatTickSettings(project);
  const effective = effectiveSeatTickSettings(stored, Date.parse(stored.until!) + 1, 3600000);
  expect(effective.curation).toMatchObject({ enabled: true, intervalHours: 1 });
  expect(seatTickSettingsAfterLapse(project, effective).curation).toEqual(stored.curation);
});


test("UI, seat and verified gateway instruction writes retain each line's actual author", async () => {
  setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  const original = await (await put({ project: PROJECT, reason: "Preserve  operator wording.\nSecond line." })).json() as SeatTickSettingsAnswer;
  const operatorLines = original.settings.instructionLines;
  expect(operatorLines).toHaveLength(2);
  expect(operatorLines?.every(line => line.author?.kind === "gateway" && line.at === original.settings.updatedAt)).toBe(true);
  setCallerConversationResolverForTests(() => SEAT_CONVERSATION);
  const noted = await (await put({ project: PROJECT, reason: "Seat note.", actor: { kind: "gateway" },
    instructionLines: [{ text: "Forged instruction.", author: { kind: "gateway" }, at: "2026-01-01T00:00:00.000Z" }] },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY })).json() as SeatTickSettingsAnswer;
  expect(noted.settings.instructionLines?.slice(0, 2)).toEqual(operatorLines);
  expect(noted.settings.instructionLines?.at(-1)).toEqual({ text: "Seat note.", at: noted.settings.updatedAt,
    author: { kind: "manager", conversationId: SEAT_CONVERSATION, project: PROJECT, seatEpoch: 12 } });
  const gateway = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: "conversation_gateway" }),
    callerProject: () => PROJECT, authorizedSeats: () => [],
  } as never);
  await gateway.seat_tick_settings({ clientRequestId: "instruction-gateway", project: PROJECT, reason: "Gateway instruction.", actor: { kind: "manager" } });
  const gatewayLines = readSeatTickSettings(PROJECT, settingsFile).instructionLines!;
  expect(gatewayLines.map(line => line.text)).toEqual(["Gateway instruction.", "Seat note."]);
  expect(gatewayLines[0]!.author?.kind).toBe("gateway");
  expect(gatewayLines[1]).toEqual(noted.settings.instructionLines!.at(-1)!);
  const rootSeat = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: SEAT_CONVERSATION }),
    callerProject: () => PROJECT, authorizedSeats: () => [{ project: PROJECT, conversationId: SEAT_CONVERSATION, path: null }],
  } as never);
  await rootSeat.seat_tick_settings({ clientRequestId: "instruction-root-seat", project: PROJECT, reason: "Revised seat note.", author: { kind: "gateway" } });
  const stored = readSeatTickSettings(PROJECT, settingsFile);
  expect(stored.instructionLines?.[0]).toEqual(gatewayLines[0]!);
  expect(stored.instructionLines?.at(-1)?.author).toMatchObject({ kind: "manager", seatEpoch: 12 });
  expect(stored.reason).toBe("Gateway instruction.\nRevised seat note.");
});

test("an unverified HTTP script cannot stamp its text as operator instructions", async () => {
  for (const headers of [
    { "content-type": "application/json", host: "127.0.0.1:8898" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "unverified" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  ]) {
    const response = await put({ project: PROJECT, reason: "Claimed operator text.", actor: { kind: "gateway" } }, headers);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("identified author");
    expectNothingStored();
  }
});


test("a delayed seat request merges into the operator's latest lines at write admission", async () => {
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  await put({ project: PROJECT, reason: "Original operator instruction." });
  setCallerConversationResolverForTests(() => SEAT_CONVERSATION);
  let release!: (value: unknown) => void;
  const body = new Promise<unknown>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const request = new NextRequest(URL_BASE, { method: "PUT", headers: { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY }, body: "{}" });
  request.json = async () => { started(); return body; };
  const pending = PUT(request);
  await reading;
  await put({ project: PROJECT, reason: "Latest operator instruction." });
  const protectedLine = readSeatTickSettings(PROJECT, settingsFile).instructionLines![0]!;
  release({ project: PROJECT, reason: "Seat note after its wait." });
  expect((await pending).status).toBe(200);
  const stored = readSeatTickSettings(PROJECT, settingsFile);
  expect(stored.instructionLines![0]).toEqual(protectedLine);
  expect(stored.reason).toBe("Latest operator instruction.\nSeat note after its wait.");
});


test("a replacement seat epoch never stamps a predecessor's instruction", async () => {
  setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  seatFile({ project: PROJECT, conversationId: "conversation_replacement_seat", seatEpoch: 13 });
  const predecessor = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: SEAT_CONVERSATION }),
    callerProject: () => PROJECT,
    authorizedSeats: () => [{ project: PROJECT, conversationId: SEAT_CONVERSATION, path: null }],
  } as never);
  await predecessor.seat_tick_settings({ clientRequestId: "instruction-replaced-seat", reason: "A predecessor note." });
  const line = readSeatTickSettings(PROJECT, settingsFile).instructionLines![0]!;
  expect(line.author?.kind).not.toBe("gateway");
  expect(line.author?.conversationId).toBe(SEAT_CONVERSATION);
  expect(line.author?.seatEpoch).toBeNull();
});


test("instruction attribution keeps the existing authority of unrelated settings controls", async () => {
  setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  const rootSeat = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: SEAT_CONVERSATION }),
    callerProject: () => PROJECT,
    authorizedSeats: () => [{ project: PROJECT, conversationId: SEAT_CONVERSATION, path: null }],
  } as never);
  await rootSeat.seat_tick_settings({ clientRequestId: "instruction-control-authority", reason: "Seat note.", autoRotate: { enabled: true, thresholdPercent: 60 } });
  const stored = readSeatTickSettings(PROJECT, settingsFile);
  expect(stored.autoRotate).toMatchObject({ enabled: true, thresholdPercent: 60, setBy: { kind: "gateway" } });
  expect(stored.instructionLines![0]!.author).toMatchObject({ kind: "manager", seatEpoch: 12 });
  const scriptControl = await put({ project: PROJECT, autoRotate: { enabled: false } }, { "content-type": "application/json", host: "127.0.0.1:8898" });
  expect(scriptControl.status).toBe(200);
  expect(readSeatTickSettings(PROJECT, settingsFile).autoRotate?.enabled).toBe(false);
  expect(readSeatTickSettings(PROJECT, settingsFile).instructionLines).toEqual(stored.instructionLines!);
});


test("an active root seat remains the instruction author when manager authority is unavailable", async () => {
  setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  await put({ project: PROJECT, reason: "Preserve operator instruction." });
  const operatorLine = readSeatTickSettings(PROJECT, settingsFile).instructionLines![0]!;
  const rootSeat = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: SEAT_CONVERSATION }),
    callerProject: () => PROJECT,
    authorizedSeats: () => [],
  } as never);
  await rootSeat.seat_tick_settings({ clientRequestId: "instruction-seat-without-authority", reason: "Seat note." });
  const stored = readSeatTickSettings(PROJECT, settingsFile);
  expect(stored.instructionLines![0]).toEqual(operatorLine);
  expect(stored.instructionLines![1]!.author).toMatchObject({ kind: "manager", conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  expect(stored.reason).toBe("Preserve operator instruction.\nSeat note.");
});

test("the operator browser can clear a full legacy field and save new instructions atomically", async () => {
  const legacy = { ...readSeatTickSettings(PROJECT, settingsFile), reason: "u".repeat(500), updatedAt: "2026-10-01T12:00:00.000Z" };
  writeSeatTickSettings(PROJECT, legacy, settingsFile);
  expect(readSeatTickSettings(PROJECT, settingsFile).instructionLines).toEqual([
    { text: "u".repeat(500), author: null, at: null },
  ]);

  const response = await put({ project: PROJECT, clearUnknownInstructions: true, reason: "New operator instruction." });
  expect(response.status).toBe(200);
  const stored = readSeatTickSettings(PROJECT, settingsFile);
  expect(stored.reason).toBe("New operator instruction.");
  expect(stored.instructionLines).toEqual([
    { text: "New operator instruction.", author: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, at: stored.updatedAt },
  ]);
});

test("a seat request cannot use the operator-only legacy instruction removal", async () => {
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  const legacy = { ...readSeatTickSettings(PROJECT, settingsFile), reason: "u".repeat(500) };
  writeSeatTickSettings(PROJECT, legacy, settingsFile);
  setCallerConversationResolverForTests(() => SEAT_CONVERSATION);
  const response = await put({ project: PROJECT, clearUnknownInstructions: true }, {
    ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY,
  });
  expect(response.status).toBe(403);
  expect(readSeatTickSettings(PROJECT, settingsFile).reason).toBe("u".repeat(500));
});

test("only the operator browser can replace seat instructions", async () => {
  setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  const settings = { ...readSeatTickSettings(PROJECT, settingsFile), reason: "Seat note.", instructionLines: [{ text: "Seat note.", author: { kind: "manager" as const, conversationId: SEAT_CONVERSATION, project: PROJECT, seatEpoch: 12 }, at: "2026-10-01T12:00:00.000Z" }] };
  writeSeatTickSettings(PROJECT, settings, settingsFile);
  setCallerConversationResolverForTests(() => SEAT_CONVERSATION);
  const refused = await put({ project: PROJECT, replaceOtherInstructions: true, reason: "Attempted replacement." }, {
    ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY,
  });
  expect(refused.status).toBe(403);
  expect(readSeatTickSettings(PROJECT, settingsFile).reason).toBe("Seat note.");

  const accepted = await put({ project: PROJECT, replaceOtherInstructions: true, reason: "Operator replacement." });
  expect(accepted.status).toBe(200);
  expect(readSeatTickSettings(PROJECT, settingsFile).instructionLines).toEqual([
    { text: "Operator replacement.", author: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, at: readSeatTickSettings(PROJECT, settingsFile).updatedAt },
  ]);
});
