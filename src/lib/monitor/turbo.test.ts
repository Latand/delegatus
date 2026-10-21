import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TURBO_HISTORY_LIMIT, TURBO_SWITCH_LIMIT, turboActive, turboCreditExempt, turboAccountVerdict, turboMandate, turboNotice,
  turboProgress, upsertTurboSwitches, type TurboPlanAccount, type TurboSwitch,
} from "./turbo";
import { applySeatTickSettingsChange, defaultSeatTickSettings, effectiveSeatTickSettings, seatTickSettingsAfterLapse, type SeatTickSettings, type SeatTickSettingsActor, type SeatTickSettingsChange } from "./seatTickSettings";
import type { EngineLimits } from "@/lib/types";
import { seatTickWakeMessage } from "./report";

const project = "turbo-fixture";
const at = "2026-10-21T12:00:00.000Z";
const now = Date.parse(at);
const hour = 3_600_000;
const operator: SeatTickSettingsActor = { kind: "gateway", project: null, conversationId: null, seatEpoch: null };
const seat: SeatTickSettingsActor = { kind: "manager", project, conversationId: "conversation_seat", seatEpoch: 1 };
const worker: SeatTickSettingsActor = { kind: "agent", project, conversationId: "conversation_worker", seatEpoch: null };
const foreignSeat: SeatTickSettingsActor = { kind: "manager", project: "other", conversationId: "conversation_other", seatEpoch: 1 };
const plan: TurboPlanAccount[] = [
  { accountId: "acct-a", label: "Account A", plan: "promax", tiers: { "gpt-6.1-sol": "ultrafast", "gpt-6-luna": "priority" }, hadCredits: true },
  { accountId: "acct-b", label: "Account B", plan: "pro", tiers: { "gpt-6.1-sol": "priority" }, hadCredits: true },
  { accountId: "acct-c", label: "Account C", plan: "prolite", tiers: { "gpt-6.1-sol": "priority" }, hadCredits: false },
];
const turboContext = { plan, allowedAccounts: ["acct-a", "acct-b", "acct-c"] };

function change(row: SeatTickSettings, fields: SeatTickSettingsChange, actor = operator, time = now) {
  const result = applySeatTickSettingsChange(row, fields, { actor, at: new Date(time).toISOString(), turbo: turboContext });
  if (!result.ok) throw new Error(result.error);
  return result.settings;
}
const refused = (row: SeatTickSettings, fields: SeatTickSettingsChange, actor = operator, time = now) => {
  const result = applySeatTickSettingsChange(row, fields, { actor, at: new Date(time).toISOString(), turbo: turboContext });
  return result.ok ? null : result.error;
};
const on = (fields: Record<string, unknown> = {}) => change(defaultSeatTickSettings(project), { turbo: { enabled: true, ...fields } });

test("fresh processes retain the original tier, reconcile expiry and preserve the switch deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-restart-"));
  try {
    const script = `
      const { readSeatTickSettings, writeSeatTickSettings, updateTurboEpisode } = await import("./src/lib/monitor/seatTickSettings");
      const { endedTurbo } = await import("./src/lib/monitor/turbo");
      const { TurboSweep } = await import("./src/lib/monitor/turboSweep");
      const project = "turbo-restart-fixture";
      if (process.argv.at(-1) === "seed") {
        const row = JSON.parse(process.env.TURBO_RESTART_ROW);
        writeSeatTickSettings(project, { ...row, project });
      } else {
        const now = Date.parse(["recover-active", "recover-cut"].includes(process.argv.at(-1)) ? "2026-10-21T12:03:00.000Z" : "2026-10-21T15:00:00.000Z");
        const calls = [];
        const continuations = [];
        await new TurboSweep({ now: () => now, sleep: () => new Promise(() => {}),
          read: () => ({ turbo: endedTurbo(readSeatTickSettings(project).turbo, now) }),
          update: (project, key, fn) => updateTurboEpisode(project, key, fn),
          candidates: async () => { throw new Error("expired episodes never discover acceleration candidates"); },
          liveTier: async () => ({ live: true, tier: "ultrafast" }),
          reading: () => ({ stale: false, limits: { session: null, weekly: { usedPercent: 10, resetsAt: null }, plan: "pro", capturedAt: null, credits: { hasCredits: false, balance: null, unlimited: false } } }),
          setTier: async (id, key, tier, cut) => { calls.push({ tier, cut }); return { cut: "none" }; },
          cutState: (_key, _id, turnId) => turnId === "interrupted-turn" ? "cut" : "unknown", cancelCut: async () => {},
          continueConversation: async (id, key) => { continuations.push({ id, key }); },
          notify: async () => ({ delivered: true }),
        }).kick(project);
        if (process.argv.at(-1) === "recover-cut") {
          while (readSeatTickSettings(project).turbo.switches[0].state === "armed") await new Promise(resolve => setImmediate(resolve));
        }
        console.log(JSON.stringify({ calls, continuations, episode: readSeatTickSettings(project).turbo }));
      }
    `;
    const row = on({ hours: 1, credits: true, creditAccounts: ["acct-a"] });
    row.turbo!.switches = [{ conversationId: "conversation_restart", accountId: "acct-a", model: "gpt-6.1-sol", from: "default", to: "ultrafast", state: "applying", at }];
    const environment = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "xdg"), TMPDIR: path.join(root, "tmp"),
      LLV_STATE_DIR: path.join(root, "state"), LLV_SEAT_TICK_SETTINGS_FILE: path.join(root, "state", "seat-tick-settings.json"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
      TURBO_RESTART_ROW: JSON.stringify(row) };
    for (const key of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"] as const) fs.mkdirSync(environment[key]!, { recursive: true });
    const run = async (phase: string) => {
      const child = Bun.spawn([process.execPath, "--eval", script, phase], { cwd: process.cwd(), env: environment, stdout: "pipe", stderr: "pipe" });
      const watchdog = setTimeout(() => child.kill(), 15_000);
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        return stdout;
      } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited; } }
    };
    await run("seed");
    const result = JSON.parse(await run("recover"));
    expect(result.calls).toEqual([{ tier: "default", cut: "none" }]);
    expect(result.episode.switches[0].state).toBe("reverted");
    expect(result.episode.revertedAt).toBeDefined();
    expect(result.episode.credits.approved).toBe(false);
    const active = on({ hours: 2 });
    active.turbo!.switches = [{ ...row.turbo!.switches[0]!, state: "queued", startedAt: at }];
    environment.TURBO_RESTART_ROW = JSON.stringify(active);
    await run("seed");
    const resumed = JSON.parse(await run("recover-active"));
    expect(resumed.calls).toEqual([]);
    expect(resumed.episode.switches[0]).toMatchObject({ state: "failed", reason: "timed out", startedAt: at });
    active.turbo!.switches = [{ ...row.turbo!.switches[0]!, state: "armed", cutTurnId: "interrupted-turn" }];
    environment.TURBO_RESTART_ROW = JSON.stringify(active);
    await run("seed");
    const recoveredCut = JSON.parse(await run("recover-cut"));
    expect(recoveredCut.calls).toEqual([]);
    expect(recoveredCut.continuations).toEqual([{ id: "conversation_restart", key: `turbo:${at}:conversation_restart:continue` }]);
    expect(recoveredCut.episode.switches[0].state).toBe("switched");
    expect(JSON.parse(await run("recover-cut")).continuations).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Turbo is off by default; the operator turns it on for 2 h, 1/2/4/8 h or until off; expiry is read on every read", () => {
  expect(turboActive(defaultSeatTickSettings(project).turbo, now)).toBe(false);
  let row = on();
  expect(row.turbo).toMatchObject({ enabled: true, startedAt: at, until: new Date(now + 2 * hour).toISOString(), endedAt: null, setBy: operator, plan,
    credits: { approved: false, accounts: [] }, switches: [] });
  expect(turboActive(row.turbo, now + 2 * hour - 1)).toBe(true);
  expect(turboActive(row.turbo, now + 2 * hour)).toBe(false);
  // A stopped Viewer cannot keep a past deadline alive: the read itself ends it.
  expect(effectiveSeatTickSettings(row, now + 3 * hour, hour).turbo).toMatchObject({ enabled: false, endReason: "expired", endedAt: row.turbo!.until });
  for (const hours of [1, 2, 4, 8]) expect(on({ hours }).turbo!.until).toBe(new Date(now + hours * hour).toISOString());
  expect(on({ hours: null }).turbo!.until).toBeNull();
  for (const hours of [0, 3, 12, 24, -1, "2"]) expect(refused(defaultSeatTickSettings(project), { turbo: { enabled: true, hours: hours as number } })).toContain("1, 2, 4 or 8");
  row = change(row, { turbo: { enabled: false } }, operator, now + hour);
  expect(row.turbo).toMatchObject({ enabled: false, endReason: "turned-off", endedAt: new Date(now + hour).toISOString() });
});

test("only the operator enables or extends; the seat shortens or turns off with a why; workers and other seats are refused", () => {
  const row = on();
  expect(refused(defaultSeatTickSettings(project), { turbo: { enabled: true, why: "operator asked" } }, seat)).toContain("only the operator");
  expect(refused(row, { turbo: { hours: 8, why: "operator asked" } }, seat)).toContain("only the operator");
  expect(refused(row, { turbo: { hours: 1 } }, seat)).toContain("why");
  expect(change(row, { turbo: { hours: 1, why: "limits drain too fast" } }, seat).turbo!.until).toBe(new Date(now + hour).toISOString());
  expect(change(row, { turbo: { enabled: false, why: "lane finished" } }, seat).turbo).toMatchObject({ enabled: false, why: "lane finished", setBy: seat });
  expect(refused(row, { turbo: { enabled: false, why: "x" } }, worker)).toContain("only the operator or this project's seat");
  expect(refused(row, { turbo: { enabled: false, why: "x" } }, foreignSeat)).toContain("only the operator or this project's seat");
  // An extension keeps the episode; a new start after off is a new episode.
  const extended = change(row, { turbo: { hours: 4 } }, operator, now + hour);
  expect(extended.turbo).toMatchObject({ startedAt: at, until: new Date(now + 5 * hour).toISOString() });
  const restarted = change(change(row, { turbo: { enabled: false } }), { turbo: { enabled: true } }, operator, now);
  expect(restarted.turbo!.startedAt).not.toBe(at);
  expect(restarted.turboHistory?.[0]?.startedAt).toBe(at);
});

test("the paid-credit approval is separate, off by default, operator-only, names accounts, needs a finite 1–8 h episode", () => {
  expect(on().turbo!.credits.approved).toBe(false);
  const paid = on({ credits: true, creditAccounts: ["acct-a", "acct-b"], hours: 4 });
  expect(paid.turbo!.credits).toMatchObject({ approved: true, accounts: ["acct-a", "acct-b"], approvedAt: at, withdrawnAt: null });
  // «Until off» is never offered with credits.
  expect(refused(defaultSeatTickSettings(project), { turbo: { enabled: true, hours: null, credits: true, creditAccounts: ["acct-a"] } })).toContain("1–8 h");
  expect(refused(on(), { turbo: { hours: null, credits: true, creditAccounts: ["acct-a"] } })).toContain("1–8 h");
  // It rides only on an enable or an extension, from the operator, naming allowed accounts.
  expect(refused(on(), { turbo: { credits: true, creditAccounts: ["acct-a"] } })).toContain("enables or extends");
  expect(refused(defaultSeatTickSettings(project), { turbo: { enabled: true, credits: true, creditAccounts: [] } })).toContain("name the accounts");
  expect(refused(defaultSeatTickSettings(project), { turbo: { enabled: true, credits: true, creditAccounts: ["acct-z"] } })).toContain("not allowed");
  expect(refused(on(), { turbo: { hours: 1, credits: true, creditAccounts: ["acct-a"], why: "operator said so" } }, seat)).toContain("only the operator");
  // The seat may withdraw it, with a why, and Turbo stays on.
  expect(refused(paid, { turbo: { credits: false } }, seat)).toContain("why");
  const withdrawn = change(paid, { turbo: { credits: false, why: "spend looks high" } }, seat);
  expect(withdrawn.turbo).toMatchObject({ enabled: true, credits: { approved: false, accounts: ["acct-a", "acct-b"], withdrawnBy: seat, withdrawnWhy: "spend looks high" } });
  // An extension asks again: extending without the approval drops it.
  expect(change(paid, { turbo: { hours: 8 } }, operator, now + hour).turbo!.credits.approved).toBe(false);
  expect(change(paid, { turbo: { hours: 8, credits: true, creditAccounts: ["acct-a"] } }, operator, now + hour).turbo!.credits).toMatchObject({ approved: true, accounts: ["acct-a"] });
  // It ends with the episode.
  const off = change(paid, { turbo: { enabled: false } }, operator, now + hour);
  expect(off.turbo!.credits.approved).toBe(false);
  expect(turboCreditExempt(off.turbo, "acct-a", now + hour)).toBe(false);
});

test("the credit guard exemption covers only named accounts, while the episode and its approval last", () => {
  const paid = on({ credits: true, creditAccounts: ["acct-a"], hours: 2 }).turbo!;
  expect(turboCreditExempt(paid, "acct-a", now)).toBe(true);
  expect(turboCreditExempt(paid, "acct-b", now)).toBe(false);
  expect(turboCreditExempt(paid, "acct-a", now + 2 * hour)).toBe(false);
  expect(turboCreditExempt(on().turbo, "acct-a", now)).toBe(false);
  expect(turboCreditExempt(null, "acct-a", now)).toBe(false);
});

test("credit rule: credit-holding accounts stop at 90 % without approval; missing or stale readings count as holding credits", () => {
  const limits = (usedPercent: number, credits?: EngineLimits["credits"]): EngineLimits => ({ session: { usedPercent: 10, resetsAt: null }, weekly: { usedPercent, resetsAt: null }, plan: "pro", capturedAt: null, ...(credits ? { credits } : {}) });
  const holding = { hasCredits: true, balance: "412", unlimited: false };
  const none = { hasCredits: false, balance: null, unlimited: false };
  const free = on().turbo!;
  const paid = on({ credits: true, creditAccounts: ["acct-a"] }).turbo!;
  expect(turboAccountVerdict(free, "acct-c", { limits: limits(99, none), stale: false }, now)).toMatchObject({ verdict: "raise" });
  expect(turboAccountVerdict(free, "acct-a", { limits: limits(89.9, holding), stale: false }, now)).toMatchObject({ verdict: "raise" });
  expect(turboAccountVerdict(free, "acct-a", { limits: limits(90, holding), stale: false }, now)).toMatchObject({ verdict: "hold" });
  expect(turboAccountVerdict(free, "acct-a", { limits: { ...limits(10, holding), session: { usedPercent: 95, resetsAt: null } }, stale: false }, now)).toMatchObject({ verdict: "hold" });
  expect(turboAccountVerdict(free, "acct-a", { limits: limits(90, { hasCredits: false, balance: null, unlimited: true }), stale: false }, now)).toMatchObject({ verdict: "hold" });
  expect(turboAccountVerdict(free, "acct-c", { limits: limits(95, none), stale: true }, now)).toMatchObject({ verdict: "hold" });
  expect(turboAccountVerdict(free, "acct-c", { limits: limits(10, undefined), stale: false }, now)).toMatchObject({ verdict: "raise" });
  expect(turboAccountVerdict(free, "acct-c", { limits: limits(95, undefined), stale: false }, now)).toMatchObject({ verdict: "hold" });
  expect(turboAccountVerdict(free, "acct-c", null, now)).toMatchObject({ verdict: "hold" });
  // With the approval only the named account keeps going past 90 %.
  expect(turboAccountVerdict(paid, "acct-a", { limits: limits(99.5, holding), stale: false }, now)).toMatchObject({ verdict: "spend" });
  expect(turboAccountVerdict(paid, "acct-b", { limits: limits(95, holding), stale: false }, now)).toMatchObject({ verdict: "hold" });
  expect(turboAccountVerdict(paid, "acct-a", { limits: limits(95, holding), stale: false }, now + 3 * hour)).toMatchObject({ verdict: "hold" });
});

test("switch rows are bounded to the newest, keyed by conversation, and progress counts each state", () => {
  const row = (id: number, state: TurboSwitch["state"]): TurboSwitch => ({ conversationId: `conversation_${id}`, accountId: "acct-a", model: "gpt-6.1-sol", from: null, to: "ultrafast", state, at });
  const many = upsertTurboSwitches([], Array.from({ length: TURBO_SWITCH_LIMIT + 7 }, (_, i) => row(i, "queued")));
  expect(many).toHaveLength(TURBO_SWITCH_LIMIT);
  expect(many[0]!.conversationId).toBe("conversation_7");
  const updated = upsertTurboSwitches(many, [row(7, "switched")]);
  expect(updated).toHaveLength(TURBO_SWITCH_LIMIT);
  expect(updated.find(item => item.conversationId === "conversation_7")!.state).toBe("switched");
  expect(turboProgress([row(1, "queued"), row(2, "switched"), row(3, "armed"), row(4, "skipped"), row(5, "failed"), row(6, "applying")]))
    .toEqual({ total: 6, switched: 1, armed: 1, skipped: 1, failed: 1, pending: 2, reverted: 0 });
});

test("ended episodes keep only the newest few in history; a lapse of the wake schedule keeps Turbo", () => {
  let row = defaultSeatTickSettings(project);
  for (let i = 0; i < TURBO_HISTORY_LIMIT + 3; i += 1) {
    row = change(row, { turbo: { enabled: true } }, operator, now + i * 10_000);
    row = change(row, { turbo: { enabled: false } }, operator, now + i * 10_000 + 5_000);
  }
  expect(row.turboHistory).toHaveLength(TURBO_HISTORY_LIMIT);
  const active = change(change(defaultSeatTickSettings(project), { enabled: false, reason: "quiet", until: new Date(now + hour).toISOString() }), { turbo: { enabled: true } });
  const lapsed = effectiveSeatTickSettings(active, now + 90 * 60_000, hour);
  expect(lapsed.lapsed).toBe(true);
  expect(seatTickSettingsAfterLapse(project, lapsed).turbo?.startedAt).toBe(active.turbo!.startedAt);
});

test("the wake overlay: full text on a new revision, a pointer after, nothing once ended; names the credit approval", () => {
  const labels = (id: string) => ({ "acct-a": "Account A", "acct-b": "Account B", "acct-c": "Account C" }[id] ?? id);
  const free = on().turbo!;
  const full = turboMandate(free, now, false, labels).join("\n");
  expect(full).toContain(`Turbo on until ${free.until}`);
  expect(full).toContain("Account A: ultrafast on gpt-6.1-sol");
  expect(full).toContain("Paid credits: not approved");
  expect(full).toContain("90 %");
  expect(full).toContain("serviceTier");
  expect(full.length).toBeLessThanOrEqual(700);
  const pointer = turboMandate(free, now, true, labels).join("\n");
  expect(pointer).toContain("no paid credits");
  expect(pointer.length).toBeLessThanOrEqual(200);
  const paid = on({ credits: true, creditAccounts: ["acct-a", "acct-b"] }).turbo!;
  expect(turboMandate(paid, now, false, labels).join("\n")).toContain("Paid credits: approved for Account A, Account B on this project until");
  expect(turboMandate(paid, now, true, labels).join("\n")).toContain("paid credits approved (Account A, Account B)");
  expect(turboMandate(free, now + 3 * hour, false, labels)).toEqual([]);
});

test("the seat notices: one on, one off, each with a stable idempotency key and no operator text", () => {
  const labels = (id: string) => id.toUpperCase();
  const free = on().turbo!;
  const notice = turboNotice(free, "on", { conversations: 7 }, labels);
  expect(notice.key).toBe(`turbo:${free.startedAt}:on`);
  expect(notice.text).toContain("Turbo is on");
  expect(notice.text).toContain("7 live Codex conversation");
  expect(notice.text).toContain("progress: seat_tick_settings → turbo");
  const off = change(defaultSeatTickSettings(project), { turbo: { enabled: true } });
  const ended = change(off, { turbo: { enabled: false } }, operator, now + hour).turbo!;
  const offNotice = turboNotice(ended, "off", { conversations: 0 }, labels);
  expect(offNotice.key).toBe(`turbo:${free.startedAt}:off`);
  expect(offNotice.text).toContain("Turbo ended (turned-off");
  expect(offNotice.text).toContain("put back");
});

test("a wake with both full overlays and a full agenda stays within 4,000 characters, agenda cut first", () => {
  const autonomyRow = applySeatTickSettingsChange(defaultSeatTickSettings(project), { autonomy: { enabled: true } }, { actor: operator, at }).ok;
  expect(autonomyRow).toBe(true);
  const row = change(change(defaultSeatTickSettings(project), { autonomy: { enabled: true } }), { turbo: { enabled: true, credits: true, creditAccounts: ["acct-a", "acct-b"] } });
  const base = { project, reasons: [{ kind: "interval" as const, detail: "work" }], signals: [], deferred: 0, mandateCarriesContract: true, now };
  const quiet = seatTickWakeMessage({ ...base, items: [], autonomy: row.autonomy, turbo: row.turbo });
  expect(quiet).toContain("Full autonomy until");
  expect(quiet).toContain("Turbo on until");
  expect(quiet).toContain("Paid credits: approved for Account A, Account B");
  const busy = seatTickWakeMessage({ ...base, autonomy: row.autonomy, turbo: row.turbo, monitorPrompt: "note ".repeat(3200), operatorInstructions: "x".repeat(500),
    items: Array.from({ length: 40 }, (_, i) => ({ kind: "task" as const, id: `t${i}`, label: `work item ${i} `.repeat(20) })) });
  expect(busy.length).toBeLessThanOrEqual(4000);
  expect(busy).toContain("Full autonomy until");
  expect(busy).toContain("Turbo on until");
  expect(busy).toContain("…");
  const pointer = seatTickWakeMessage({ ...base, items: [], turbo: row.turbo, turboUnchanged: true });
  expect(pointer).toContain("paid credits approved (Account A, Account B)");
  expect(pointer).not.toContain("Delegatus switches live Codex conversations itself");
  expect(seatTickWakeMessage({ ...base, items: [], turbo: row.turbo, now: now + 3 * hour })).not.toContain("Turbo");
});

test("the guard admits an approved account for this project only; other projects on the same account still stop at 99 %", async () => {
  const { writeSeatTickSettings } = await import("./seatTickSettings");
  const { selectProjectAccount, admitAutomaticAccountTarget } = await import("@/lib/accounts/projectSelection");
  const observation = (accountId: string) => ({ engine: "codex" as const, accountId, authenticated: true, authCheckedAt: at,
    limits: { session: { usedPercent: 10, resetsAt: null }, weekly: { usedPercent: 99.5, resetsAt: Math.floor(now / 1000) + 3600 }, plan: "promax", capturedAt: Math.floor(now / 1000),
      credits: { hasCredits: true, balance: "412", unlimited: false } },
    provenance: { source: "live" as const, reason: null, staleSince: null }, observedAt: at, bootId: "boot-turbo" });
  const select = (forProject: string) => selectProjectAccount({ project: forProject, engine: "codex", accounts: [{ id: "acct-a", authPresent: true }],
    observations: [observation("acct-a")], bindings: [], requestedId: "acct-a", now });
  writeSeatTickSettings(project, change(defaultSeatTickSettings(project), { turbo: { enabled: true } }));
  expect(select(project).kind).toBe("exhausted");
  writeSeatTickSettings(project, change(defaultSeatTickSettings(project), { turbo: { enabled: true, credits: true, creditAccounts: ["acct-a"] } }));
  expect(select(project)).toEqual({ kind: "available", accountId: "acct-a" });
  expect(select("another-project").kind).toBe("exhausted");
  for (const bindings of [[], [{ project, engine: "codex" as const, accountId: "acct-a", createdAt: at }]]) {
    expect(selectProjectAccount({ project, engine: "codex", accounts: [{ id: "acct-a", authPresent: true }], observations: [observation("acct-a")],
      bindings, requestedId: "acct-a", requireCapacity: true, now }).kind).toBe("available");
  }
  expect(admitAutomaticAccountTarget({ project, engine: "codex", observations: [observation("acct-a")], bindings: [], targetId: "acct-a", now }).kind).toBe("available");
  // Expiry ends the exemption.
  expect(selectProjectAccount({ project, engine: "codex", accounts: [{ id: "acct-a", authPresent: true }], observations: [observation("acct-a")], bindings: [], requestedId: "acct-a", now: now + 3 * hour }).kind).toBe("exhausted");
});
