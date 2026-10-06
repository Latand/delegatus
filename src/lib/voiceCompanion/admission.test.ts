import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompanionEvent, Recipient } from "./contract";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-admission-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("the production admission seam refuses whole-input retractions and spoken approval", async () => {
  const storage = new CompanionStorage();
  let sends = 0;
  const recipient: Recipient = { project: "fixture-project", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" };
  const admission = new CompanionAdmission(storage, {
    recipient: () => recipient,
    send: async () => { sends++; return { status: "queued", operationId: "fixture-operation" }; },
    reports: () => [],
  });
  const session = admission.create({ project: recipient.project, locale: "en" });
  admission.input(session.id, { itemId: "input-1", text: "Ask the orchestrator to review it. Actually, do not send anything.", final: true });
  expect(admission.propose(session.id, "call-1", "input-1", "Review it")).toBeNull();
  expect(sends).toBe(0);
  admission.input(session.id, { itemId: "input-2", text: "Ask the orchestrator to review the plan.", final: true });
  const proposal = admission.propose(session.id, "call-2", "input-2", "Review the plan")!;
  await admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "speech" });
  expect(sends).toBe(0);
  await admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  expect(sends).toBe(1);
  expect(admission.events(session.id, 0).some((event: CompanionEvent) => event.type === "delegation.tool.result" && event.result.status === "queued")).toBe(true);
});

test("reordered finals, later speech, seat rotation, and restart cannot revive an unconfirmed proposal", async () => {
  const storage = new CompanionStorage();
  let epoch = 1;
  let sends = 0;
  const recipient = () => ({ project: "race-project", conversationId: "conversation_race", seatEpoch: epoch, engine: "codex" as const });
  const paths = { recipient, send: async () => { sends++; return { status: "delivered" as const, operationId: "operation-race" }; }, reports: () => [] };
  const admission = new CompanionAdmission(storage, paths);
  const session = admission.create({ project: "race-project", locale: "uk" });
  admission.input(session.id, { itemId: "older", text: "", final: false });
  admission.input(session.id, { itemId: "newer", text: "Привіт", final: true });
  admission.input(session.id, { itemId: "older", text: "Попроси оркестратора перевірити план.", final: true });
  expect(admission.propose(session.id, "stale", "older", "Перевір план")).toBeNull();
  admission.input(session.id, { itemId: "ask", text: "Попроси оркестратора перевірити план.", final: true });
  const proposal = admission.propose(session.id, "fresh", "ask", "Перевір план")!;
  admission.input(session.id, { itemId: "withdrawal", text: "", final: false });
  const restarted = new CompanionAdmission(new CompanionStorage(), paths);
  await restarted.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  expect(sends).toBe(0);
  restarted.input(session.id, { itemId: "ask-again", text: "Попроси оркестратора перевірити план.", final: true });
  const moved = restarted.propose(session.id, "moved", "ask-again", "Перевір план")!;
  epoch++;
  await restarted.confirm(session.id, { type: "confirmation", proposalId: moved.proposalId, via: "tap", decision: "send" });
  expect(sends).toBe(0);
});

test("only reports with the delivery key, project and frozen manager identity answer concurrent requests", async () => {
  const storage = new CompanionStorage();
  const recipient = { project: "reply-project", conversationId: "conversation_reply", seatEpoch: 1, engine: "claude" as const };
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => recipient,
    send: async () => ({ status: "queued", operationId: "operation-reply" }), reports: () => reports });
  const session = admission.create({ project: recipient.project, locale: "en" });
  admission.input(session.id, { itemId: "ask", text: "Ask the orchestrator to review the plan.", final: true });
  const proposal = admission.propose(session.id, "call", "ask", "Review the plan")!;
  await admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  const key = admission.session(session.id).proposals[proposal.proposalId].delivery!.clientMessageId;
  const report = (id: string, changes = {}): import("@/lib/bridge/types").BridgeReportV1 => ({ id, key: id, seq: 1, at: "2026-10-06T00:00:00Z", class: "completed", body: "Checked the plan",
    project: recipient.project, correlatesDirective: key, origin: { kind: "manager", conversationId: recipient.conversationId, role: "orchestrator" }, ...changes });
  reports = [report("unrelated", { correlatesDirective: "other-key" }), report("foreign", { project: "other-project" }),
    report("wrong-agent", { origin: { kind: "manager", conversationId: "conversation_other", role: "orchestrator" } }), report("unattributed", { origin: undefined })];
  expect(admission.pollReplies(session.id)).toEqual([]);
  reports.push(report("correct"));
  expect(admission.pollReplies(session.id)).toMatchObject([{ type: "orchestrator.answer", reportId: "correct" }]);
  expect(new CompanionAdmission(new CompanionStorage(), { recipient: () => recipient, send: async () => { throw new Error("unexpected send"); }, reports: () => reports }).pollReplies(session.id)).toEqual([]);
  expect(new CompanionStorage().read().sessions[session.id].events.filter(event => event.type === "orchestrator.answer")).toMatchObject([{ reportId: "correct", status: "result" }]);
});

test("project succession preserves an admitted voice binding and its reply correlation", async () => {
  const { admittedVoiceBinding } = await import("./admission");
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  const storage = new CompanionStorage();
  const recipient = { project: "old-project", conversationId: "conversation_succession", seatEpoch: 1, engine: "claude" as const };
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => recipient,
    send: async () => ({ status: "queued", operationId: "operation-succession" }), reports: () => reports });
  const session = admission.create({ project: recipient.project, locale: "en" });
  admission.input(session.id, { itemId: "ask", text: "Ask the orchestrator to review the plan.", final: true });
  const proposal = admission.propose(session.id, "call", "ask", "Review the plan")!;
  await admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  const held = admission.session(session.id).proposals[proposal.proposalId];
  persistProjectAliases([{ source: "old-project", target: "new-project", displayName: "Renamed fixture" }]);
  expect(admittedVoiceBinding({ sessionId: session.id, proposalId: proposal.proposalId, project: "new-project", recipient: recipient.conversationId,
    key: held.delivery!.clientMessageId, text: held.text! }, storage)).not.toBeNull();
  reports = [{ id: "succession-reply", seq: 1, at: "2026-10-06T00:00:00Z", class: "completed", project: "new-project",
    correlatesDirective: held.delivery!.clientMessageId, origin: { kind: "manager", conversationId: recipient.conversationId, role: "orchestrator" }, body: "Checked" }];
  expect(admission.pollReplies(session.id)).toMatchObject([{ type: "orchestrator.answer", reportId: "succession-reply" }]);
});

test("a late transport failure cannot overwrite a receipt recovered by another admission instance", async () => {
  const storage = new CompanionStorage();
  const recipient = { project: "overlap-project", conversationId: "conversation_overlap", seatEpoch: 1, engine: "codex" as const };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => [], send: async () => { await pending; throw new Error("lost response"); } });
  const session = admission.create({ project: recipient.project, locale: "en" });
  admission.input(session.id, { itemId: "ask", text: "Ask the orchestrator to review the plan.", final: true });
  const proposal = admission.propose(session.id, "call", "ask", "Review the plan")!;
  const command = { type: "confirmation" as const, proposalId: proposal.proposalId, via: "tap" as const, decision: "send" as const };
  const original = admission.confirm(session.id, command);
  const recovery = new CompanionAdmission(new CompanionStorage(), { recipient: () => recipient, reports: () => [],
    send: async () => ({ status: "delivered", operationId: "operation-overlap" }) });
  await recovery.confirm(session.id, command);
  release();
  await original;
  expect(admission.session(session.id).proposals[proposal.proposalId]).toMatchObject({ status: "delivered", delivery: { operationId: "operation-overlap" } });
  const results = admission.events(session.id, 0).filter(event => event.type === "delegation.tool.result" && "delivery" in event.result);
  expect(results.at(-1)).toMatchObject({ result: { status: "delivered", delivery: { operationId: "operation-overlap" } } });
});
