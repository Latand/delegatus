import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
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
};
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
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
const { readSeatTickSettings, writeSeatTickSettings, SEAT_TICK_PROMPT_LIMIT, SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES } = await import("@/lib/monitor/seatTickSettings");
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

beforeEach(() => {
  const id = crypto.randomUUID();
  settingsFile = path.join(SANDBOX, "settings", `${id}.json`);
  process.env.LLV_SEAT_TICK_SETTINGS_FILE = settingsFile;
  process.env.LLV_SEAT_TICK_STATE_FILE = path.join(SANDBOX, "state", `tick-${id}.json`);
  process.env.LLV_SEAT_TICK_AUDIT_FILE = path.join(SANDBOX, "journal", `${id}.ndjson`);
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"), { force: true });
});
afterEach(() => setCallerConversationResolverForTests(null));
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
  expect(fs.existsSync(settingsFile)).toBe(false);
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
  expect(body.cardText).toContain(`whose own project is ${OTHER_PROJECT}`);
});

test("an identified caller that holds no seat and owns no project names none, rather than inventing one", async () => {
  seatFile({ project: PROJECT, conversationId: SEAT_CONVERSATION, seatEpoch: 12 });
  setCallerConversationResolverForTests(() => OTHER_CONVERSATION);
  const body = await (await put(
    { project: PROJECT, enabled: false, reason: "a worker quieting a project it has no claim on" },
    { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY },
  )).json() as SeatTickSettingsAnswer;
  expect(body.actor).toEqual({ kind: "agent", conversationId: OTHER_CONVERSATION, project: null, seatEpoch: null });
  expect(body.cardText).toContain("Set by an agent session");
  expect(body.cardText).not.toContain("whose own project is");
});

test("the module's rules hold verbatim, and a refusal stores nothing", async () => {
  const refusals = [
    [{ project: PROJECT, enabled: false }, "a reason is required when the tick is disabled or its wake interval is changed"],
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
  /* Byte-identical, because it was never created. */
  expect(fs.existsSync(settingsFile)).toBe(false);
});

test("an expiry, and restoring the default with no reason, go through the same record", async () => {
  await put({ project: PROJECT, enabled: false, reason: "a deploy is running", untilMinutes: 90 });
  const off = readSeatTickSettings(PROJECT, settingsFile);
  expect(off.enabled).toBe(false);
  expect(Date.parse(off.until!) - Date.now()).toBeGreaterThan(89 * 60_000);
  const before = fs.readFileSync(settingsFile, "utf8");

  const restored = await (await put({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null })).json() as SeatTickSettingsAnswer;
  expect(restored.changed).toBe(true);
  expect(restored.effective).toMatchObject({ isDefault: true, enabled: true, reason: null, until: null });
  expect(restored.cardText).toBeNull();
  expect(readSeatTickSettings(PROJECT, settingsFile)).toMatchObject({ enabled: true, wakeIntervalMinutes: null, reason: null, until: null });
  expect(fs.readFileSync(settingsFile, "utf8")).not.toBe(before);
});

test("a change with no fields is a read, as the tool's is", async () => {
  const response = await put({ project: PROJECT });
  expect(response.status).toBe(200);
  const body = await response.json() as SeatTickSettingsAnswer;
  expect(body.changed).toBe(false);
  expect(body.settings.setBy).toBeNull();
  expect(fs.existsSync(settingsFile)).toBe(false);
});

test("a write from anything but the Viewer's own origin is refused before the body is read", async () => {
  const crossSite = await put({ project: PROJECT, enabled: false, reason: "from elsewhere" }, { ...browser, origin: "http://example.test", "sec-fetch-site": "cross-site" });
  expect(crossSite.status).toBe(403);
  expect((await crossSite.json()).error).toContain("cross-origin");
  expect(fs.existsSync(settingsFile)).toBe(false);
});

test("the actual state is the tick's own record and the journal, with the dispatch token never leaving the server", async () => {
  writeSeatTickState(PROJECT, {
    ...emptySeatTickState(),
    seatEpoch: 7,
    lastCheckAt: "2026-09-18T09:00:00.000Z",
    lastWakeAt: "2026-09-18T08:00:00.000Z",
    lastWakeReasons: ["interval", "stalled"],
    wakesWithoutChange: { interval: 3, stalled: 1 },
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
    retryGuard: [{ kind: "interval", wakes: 3 }],
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
  const bindings = viewerMcpBindings({
    attribution: () => ({ kind: "gateway", conversationId: null }),
    authorizedSeats: () => [],
    callerProject: () => PROJECT,
    readTickSettings: (project: string) => readSeatTickSettings(project, settingsFile),
  } as never);
  const tool = await bindings.seat_tick_settings({ clientRequestId: "tick-parity", project: PROJECT }) as unknown as {
    settings: SeatTickSettingsAnswer["settings"];
    effective: Record<string, unknown>;
    defaultWakeIntervalMinutes: number;
    monitorPromptLength: number;
  };
  expect(body.settings).toEqual(tool.settings);
  expect(body.defaultWakeIntervalMinutes).toBe(tool.defaultWakeIntervalMinutes);
  expect(body.monitorPromptLength).toBe(tool.monitorPromptLength);
  for (const field of ["enabled", "wakeIntervalMinutes", "reason", "monitorPrompt", "until", "isDefault"] as const) {
    expect(body.effective[field] as unknown, field).toEqual(tool.effective[field]);
  }
  /* The card the board carries while this stands, in the card's own words. */
  expect(body.cardText).toContain("This project's seat tick is not on its default settings");
  expect(body.cardText).toContain("one every 240 minute(s)");
  expect(body.cardText).toContain("slow it down over the weekend");
});
