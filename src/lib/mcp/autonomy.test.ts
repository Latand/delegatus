import { afterEach, expect, setSystemTime, test } from "bun:test";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/monitor/seat-tick/settings/route";
import { applySeatTickSettingsChange, defaultSeatTickSettings, readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { pendingAutonomyReports } from "@/lib/monitor/autonomy";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { setBridgeReports } from "@/lib/projects/settings";
import { viewerMcpBindings } from "./bindings";
import { TOOL_INPUT_SCHEMAS } from "./server";
import { publishPrototype, findPrototypeRound, mutatePrototypeRound } from "@/lib/prototypeReview/store";
import { decidePrototype } from "@/lib/prototypeReview/decision";
import { doneCandidates } from "@/lib/done/candidates";
import { prototypeWorld } from "@/lib/prototypeReview/world";

const at = "2026-10-15T00:00:00.000Z";
const now = Date.parse(at);
afterEach(() => setSystemTime());
const operator = { kind: "gateway" as const, project: null, conversationId: null, seatEpoch: null };
function seed(project: string) {
  const changed = applySeatTickSettingsChange(defaultSeatTickSettings(project), { autonomy: { enabled: true }, release: { enabled: true } }, { at, actor: operator });
  if (!changed.ok) throw new Error(changed.error);
  writeSeatTickSettings(project, changed.settings);
  return changed.settings;
}
function binding(project: string, kind: "manager" | "agent" = "manager") {
  return viewerMcpBindings(undefined, { get: async () => { throw new Error("unexpected control read"); }, post: async () => { throw new Error("unexpected control write"); } }, {
    callerAttribution: () => ({ kind, conversationId: "conversation_seat", role: "orchestrator" }),
    callerProject: () => project,
    authorizedSeats: () => [{ conversationId: "conversation_seat", project, path: null }],
    operatorLocale: () => "en", operatorTimeZone: () => "UTC",
    publicDenyList: () => ({ accounts: [], people: [], local: [], projects: [] }),
    listTaskRecords: () => [], loadTasks: () => [],
  } as never);
}

test("MCP carries the child flag, refuses agent enable and permits seat disable", async () => {
  setSystemTime(now);
  const project = "proactive-tool";
  const initial = seed(project);
  expect((await binding(project).seat_tick_settings({ clientRequestId: "proactive-default" })).autonomy).toMatchObject({ proactive: { enabled: false } });
  const args = { clientRequestId: "proactive-enable", autonomy: { proactive: { enabled: true }, why: "Operator asked" } };
  expect(TOOL_INPUT_SCHEMAS.seat_tick_settings.safeParse(args).success).toBe(true);
  expect(TOOL_INPUT_SCHEMAS.seat_tick_settings.safeParse({ ...args, autonomy: { proactive: { enabled: true, cap: 5 } } }).success).toBe(false);
  for (const kind of ["manager", "agent"] as const) {
    await expect(binding(project, kind).seat_tick_settings({ ...args, clientRequestId: `proactive-refused-${kind}` })).rejects.toThrow("only the operator");
  }
  const root = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "gateway", conversationId: "conversation_seat" }),
    callerProject: () => project, authorizedSeats: () => [{ conversationId: "conversation_seat", project, path: null }],
  } as never);
  await expect(root.seat_tick_settings({ ...args, clientRequestId: "proactive-refused-root" })).rejects.toThrow("only the operator");
  expect(readSeatTickSettings(project).autonomy?.proactive?.enabled ?? false).toBe(false);
  const enabled = applySeatTickSettingsChange(initial, args, { at, actor: operator });
  if (!enabled.ok) throw new Error(enabled.error);
  writeSeatTickSettings(project, enabled.settings);
  expect((await binding(project).seat_tick_settings({ clientRequestId: "proactive-read", verbose: true })).autonomy).toMatchObject({ proactive: { enabled: true }, episode: { proactive: { enabled: true } } });
  await binding(project).seat_tick_settings({ clientRequestId: "proactive-stop", autonomy: { proactive: { enabled: false }, why: "Reserve requested capacity" } });
  expect((await binding(project).seat_tick_settings({ clientRequestId: "proactive-stopped" })).autonomy).toMatchObject({ active: true, proactive: { enabled: false } });
});

test("browser API persists default duration and extension; MCP seat can only shorten", async () => {
  setSystemTime(now);
  const project = "autonomy-api";
  const put = (autonomy: unknown) => PUT(new NextRequest("http://localhost/api/monitor/seat-tick/settings", {
    method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ project, autonomy }),
  }));
  const on = await put({ enabled: true });
  expect(on.status).toBe(200);
  expect((await on.json()).autonomy).toMatchObject({ active: true, until: "2026-10-15T08:00:00.000Z" });
  expect((await (await put({ hours: 12 })).json()).autonomy.until).toBe("2026-10-15T12:00:00.000Z");
  expect((await (await put({ hours: null })).json()).autonomy.until).toBeNull();
  const api = binding(project);
  const shortened = { clientRequestId: "shorten", autonomy: { hours: 1, why: "Finish sooner" } };
  expect(TOOL_INPUT_SCHEMAS.seat_tick_settings.safeParse(shortened).success).toBe(true);
  expect((await api.seat_tick_settings(shortened)).changed).toBe(true);
  await expect(api.seat_tick_settings({ clientRequestId: "extend", autonomy: { hours: 2, why: "The operator asked" } })).rejects.toThrow("only shorten");
  await expect(binding(project, "agent").seat_tick_settings({ clientRequestId: "worker", autonomy: { enabled: false, why: "stop" } })).rejects.toThrow("only the operator");
  setSystemTime(now + 3_600_000);
  const read = await api.seat_tick_settings({ clientRequestId: "expired", verbose: true });
  expect(read.autonomy).toMatchObject({ active: false });
});

test("release askBeforePublish is skipped only during a live episode; stored setting stays true", async () => {
  setSystemTime(now);
  const project = "autonomy-release";
  const api = binding(project);
  const before = await api.seat_tick_settings({ clientRequestId: "before" });
  expect(before.release).toMatchObject({ effectiveAskBeforePublish: true });
  seed(project);
  expect((await api.seat_tick_settings({ clientRequestId: "active" })).release).toMatchObject({ askBeforePublish: true, effectiveAskBeforePublish: false });
  setSystemTime(now + 8 * 3_600_000);
  expect((await api.seat_tick_settings({ clientRequestId: "at-expiry" })).release).toMatchObject({ effectiveAskBeforePublish: true });
  setSystemTime(now);
  await api.seat_tick_settings({ clientRequestId: "off", autonomy: { enabled: false, why: "Operator returned" } });
  expect((await api.seat_tick_settings({ clientRequestId: "off-read" })).release).toMatchObject({ askBeforePublish: true, effectiveAskBeforePublish: true });
});

test("recording an autonomous decision leaves the operator as the settings' last editor", () => {
  const project = "autonomy-editor";
  const seeded = seed(project);
  const seat = { kind: "manager" as const, project, conversationId: "conversation_seat", seatEpoch: 1 };
  const later = new Date(now + 60_000).toISOString();
  const logged = applySeatTickSettingsChange(seeded, { autonomyDecision: { startedAt: at, id: "d1", decision: "Keep layout", why: "Fits", undo: "Choose spacious" } }, { at: later, actor: seat });
  if (!logged.ok) throw new Error(logged.error);
  expect(logged.settings.autonomy?.decisions[0]?.by).toEqual(seat);
  expect(logged.settings.setBy).toEqual(operator);
  expect(logged.settings.updatedAt).toBe(seeded.updatedAt);
  const edited = applySeatTickSettingsChange(seeded, { monitorPrompt: "Watch the board", autonomyDecision: { startedAt: at, id: "d2", decision: "Keep layout", why: "Fits", undo: "Choose spacious" } }, { at: later, actor: seat });
  if (!edited.ok) throw new Error(edited.error);
  expect(edited.settings.setBy).toEqual(seat);
});

test("one ended-episode report survives retry, appears as a Done outcome, and returns identical chat text with reports off", async () => {
  setSystemTime(now);
  const project = "autonomy-report";
  seed(project);
  const api = binding(project);
  await api.seat_tick_settings({ clientRequestId: "decision", autonomyDecision: { startedAt: at, id: "choice", decision: "Keep compact layout", why: "Fits the phone", undo: "Choose spacious on the saved form" } });
  await expect(api.bridge_report({ clientRequestId: "too-early", key: `autonomy:${at}`, class: "status", outcome: "autonomy", summary: "Finished" })).rejects.toThrow("ended episode");
  setSystemTime(now + 8 * 3_600_000);
  setBridgeReports(project, false, "operator");
  await expect(api.bridge_report({ clientRequestId: "reserved-key", key: `autonomy:${at}`, class: "status", summary: "Pretend report" })).rejects.toThrow("require outcome autonomy");
  const args = { clientRequestId: "end-report", key: `autonomy:${at}`, class: "status", outcome: "autonomy", summary: "Autonomy finished", body: "Completed: layout reviewed. Decisions: compact; undo by choosing spacious. Started: no new tasks. Waiting: none. Problems: none." };
  const first = await api.bridge_report(args);
  expect(first.recorded).toBe(true);
  const report = readBridgeReportLog().reports.find(report => report.project === project)!;
  expect(report.outcome?.kind).toBe("autonomy");
  expect(first.chatText).toBe(report.body);
  const done = doneCandidates({ now: Date.now(), floor: now, forge: { schemaVersion: 1, repositories: {} }, pipelines: [], tasks: [], deployments: [], reports: [report], limits: {}, pipelineRepository: () => null, repositoryProject: () => null });
  expect(done.candidates).toHaveLength(1);
  expect(done.candidates[0]).toMatchObject({ kind: "report", title: "Autonomy finished" });
  expect(report.telegram).toBeUndefined();
  expect(pendingAutonomyReports(readSeatTickSettings(project), now + 8 * 3_600_000)).toHaveLength(0);
  const replay = await api.bridge_report({ ...args, clientRequestId: "end-report-retry" });
  expect(replay.alreadyRecorded).toBe(true);
  expect(replay.chatText).toBe(first.chatText);
  expect(readBridgeReportLog().reports.filter(report => report.project === project)).toHaveLength(1);
});

test("autonomous form choices are attributed to the seat and remain amendable by the operator", async () => {
  setSystemTime(now);
  const project = "autonomy-forms";
  seed(project);
  const round = await publishPrototype({ clientRequestId: "form", title: "Choose layout", questions: [{ id: "layout", text: "Which layout?", options: [{ label: "Compact", recommended: true }, { label: "Spacious" }], other: true }] }, null, { conversationId: "conversation_seat" }, project);
  const world = { ...prototypeWorld, orchestrator: () => null };
  const answer = { reviewId: round.id, chosen: [], comment: "Compact fits. Undo: choose spacious.", answers: [{ questionId: "layout", options: [0] }] };
  expect(decidePrototype({ kind: "autonomous-seat", project, conversationId: "conversation_seat", authorize: () => {} }, null, answer, world)).toBe(true);
  const saved = findPrototypeRound(null, round.id)!;
  expect(saved.decision?.decidedBy).toEqual({ kind: "agent", conversationId: "conversation_seat" });
  expect(saved.decision?.delivery.text).toStartWith("Autonomous seat decision");
  expect(decidePrototype(new NextRequest("http://localhost"), null, { ...answer, comment: "Use spacious", answers: [{ questionId: "layout", options: [1] }] }, world)).toBe(true);
  expect(findPrototypeRound(null, round.id)?.decision?.answers?.[0]?.options).toEqual([1]);
});


test("real MCP form decisions retain undo and reject native association, other projects and expiry", async () => {
  setSystemTime(now);
  const project = "autonomy-form-api";
  seed(project);
  const api = binding(project);
  const make = (key: string, own = project) => publishPrototype({ clientRequestId: key, title: "Choose layout", questions: [{ id: "layout", text: "Which layout?", options: [{ label: "Compact", recommended: true }, { label: "Spacious" }], other: true }] }, null, { conversationId: "conversation_seat" }, own);
  const round = await make("api-form");
  const entry = { startedAt: at, id: "form", decision: "Compact", why: "Fits", undo: "Choose Spacious on the saved form", review: { reviewId: round.id, chosen: [], comment: "Fits", answers: [{ questionId: "layout", options: [0] }] } };
  await api.seat_tick_settings({ clientRequestId: "choose", autonomyDecision: entry });
  expect(readSeatTickSettings(project).autonomy?.decisions[0]).toMatchObject({ undo: entry.undo, reviewState: "decided" });
  expect(findPrototypeRound(null, round.id)?.decision?.decidedBy).toMatchObject({ kind: "agent" });
  await api.seat_tick_settings({ clientRequestId: "choose-retry", autonomyDecision: entry });
  expect(readSeatTickSettings(project).autonomy?.decisions).toHaveLength(1);
  await expect(api.seat_tick_settings({ clientRequestId: "conflicting-review", autonomyDecision: { ...entry, review: { ...entry.review, comment: "Another choice" } } })).rejects.toThrow("different content");
  const foreign = await make("foreign-form", "other-project");
  await expect(api.seat_tick_settings({ clientRequestId: "foreign", autonomyDecision: { ...entry, id: "foreign", review: { ...entry.review, reviewId: foreign.id } } })).rejects.toThrow("cannot decide");
  const native = await make("native-form");
  mutatePrototypeRound(null, native.id, held => { held.nativeAssociation = { home: "/fixture/account", pid: 123, processIdentity: "123:10", domain: "fixture", sessionId: "session", transcript: "/fixture/session.jsonl", recordIdentity: { pid: 123, sessionId: "session", procStart: "10", pidDomain: "fixture", startedAt: now, kind: "interactive" }, generationProof: "fixture", conversationId: "conversation_native", cwd: "/fixture", startedAt: now }; });
  await expect(api.seat_tick_settings({ clientRequestId: "native", autonomyDecision: { ...entry, id: "native", review: { ...entry.review, reviewId: native.id } } })).rejects.toThrow("cannot decide");
  expect(findPrototypeRound(null, native.id)?.decision).toBeUndefined();
  const late = await make("late-form");
  setSystemTime(now + 8 * 3_600_000);
  await expect(api.seat_tick_settings({ clientRequestId: "late", autonomyDecision: { ...entry, id: "late", review: { ...entry.review, reviewId: late.id } } })).rejects.toThrow("no longer active");
  expect(findPrototypeRound(null, late.id)?.decision).toBeUndefined();
});

test("the tool schema preserves rejection and per-question skips with seat attribution", async () => {
  setSystemTime(now);
  const project = "autonomy-form-options";
  seed(project);
  const api = binding(project);
  const round = await publishPrototype({ clientRequestId: "skip-form", title: "Choose layout", questions: [
    { id: "settled", text: "Already decided?", options: [{ label: "Yes", recommended: true }, { label: "No" }], other: true },
    { id: "layout", text: "Which layout?", options: [{ label: "Compact", recommended: true }, { label: "Spacious" }], other: true },
  ] }, null, { conversationId: "conversation_seat" }, project);
  const parsed = TOOL_INPUT_SCHEMAS.seat_tick_settings.parse({ clientRequestId: "skip-question", autonomyDecision: {
    startedAt: at, id: "skip", decision: "Keep the settled answer; use a custom layout", why: "The first question was answered", undo: "Amend the saved form",
    review: { reviewId: round.id, chosen: [], comment: "Keep this literal text: Skipped by the operator", answers: [
      { questionId: "settled", options: [], skipped: true }, { questionId: "layout", options: [], other: true, customText: "Compact with a wider title" },
    ] },
  } });
  await api.seat_tick_settings(parsed);
  const decision = findPrototypeRound(null, round.id)!.decision!;
  expect(decision.answers?.[0]?.skipped).toBe(true);
  expect(decision.delivery.text).toContain("Skipped by the seat");
  expect(decision.delivery.text).toContain("Seat's custom note");
  expect(decision.delivery.text).toContain("Keep this literal text: Skipped by the operator");

  const variant = await publishPrototype({ clientRequestId: "reject-form", title: "Reject layout", questions: [
    { id: "layout", text: "Which layout?", options: [{ label: "Compact", recommended: true }, { label: "Spacious" }], other: true },
  ] }, null, { conversationId: "conversation_seat" }, project);
  mutatePrototypeRound(null, variant.id, held => {
    delete held.questions;
    held.variants = [{ number: 1, name: "Compact", description: "A compact layout", frames: [], videos: [] }];
  });
  await api.seat_tick_settings(TOOL_INPUT_SCHEMAS.seat_tick_settings.parse({ clientRequestId: "reject-variants", autonomyDecision: {
    startedAt: at, id: "reject", decision: "Revise the layout", why: "The title is clipped", undo: "Amend the saved form and choose Compact",
    review: { reviewId: variant.id, chosen: [], comment: "Keep the full title visible", reject: true },
  } }));
  expect(findPrototypeRound(null, variant.id)?.decision?.rejected).toBe(true);
  expect(readSeatTickSettings(project).autonomy?.decisions.at(-1)?.reviewState).toBe("decided");
});
