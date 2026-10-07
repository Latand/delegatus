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
const { INITIAL_COMPANION_STATE, reduceCompanion } = await import("./reducer");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("a Live request needs no completed transcript and is sent at once, exactly once, with no tap", async () => {
  const sent: string[] = [];
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "duplex", conversationId: "conversation_duplex", seatEpoch: 1, engine: "claude" }),
    send: async ({ delivery }) => { sent.push(delivery.clientMessageId); return { status: "queued", operationId: "duplex-operation" }; }, reports: () => [],
  });
  const session = admission.create({ project: "duplex", locale: "en", authority: "live-model" });
  expect(await admission.delegate(session.id, "live-call", "live-delegation", "Review the plan")).toEqual({ state: "sent", status: "queued" });
  expect(sent.length).toBe(1);
  // The same call again, a tap and a spoken answer find the first send and add none.
  expect(await admission.delegate(session.id, "live-call", "live-delegation", "Review the plan")).toEqual({ state: "sent", status: "queued" });
  const [row] = Object.values(admission.session(session.id).proposals);
  for (const via of ["tap", "speech"] as const) await admission.confirm(session.id, { type: "confirmation", proposalId: row.proposal.proposalId, decision: "send", via });
  await admission.confirm(session.id, { type: "confirmation", proposalId: row.proposal.proposalId, decision: "cancel", via: "tap" });
  expect(sent).toEqual([row.delivery!.clientMessageId]);
  expect(row).toMatchObject({ state: "admitted", via: "auto", proposal: { authority: "live-model", instruction: "Review the plan" } });
  const types = admission.events(session.id, 0).map((event: CompanionEvent) => event.type);
  expect(types).not.toContain("delegation.confirmation.required");
  expect(types.slice(0, 3)).toEqual(["delegation.tool.called", "delegation.sending", "delegation.tool.result"]);
});

test("autosend admission commits its initial card event with the durable delivery key", () => {
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "durable-card", conversationId: "conversation_durable", seatEpoch: 1, engine: "codex" }),
    send: async () => ({ status: "queued", operationId: "unused" }), reports: () => [],
  });
  const session = admission.create({ project: "durable-card", locale: "en", authority: "live-model" });
  const proposal = admission.propose(session.id, "call-durable", "input-durable", "Review the plan", { autosend: true })!;
  const stored = admission.session(session.id);
  expect(stored.proposals[proposal.proposalId]).toMatchObject({ state: "admitted", status: "unknown", delivery: { proposalId: proposal.proposalId } });
  expect(stored.events).toHaveLength(1);
  expect(stored.events[0]).toMatchObject({ type: "delegation.tool.called", callId: proposal.callId, instruction: proposal.instruction });
});

test("a repeated Live delegation reuses its durable outcome and delivery key across call IDs and restart", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const keys: string[] = [];
  const paths = { recipient: () => ({ project: "retry", conversationId: "conversation_retry", seatEpoch: 1, engine: "codex" as const }),
    send: async ({ delivery }: { delivery: { clientMessageId: string } }) => { keys.push(delivery.clientMessageId); return { status: "delivered" as const, operationId: "retry-operation" }; }, reports: () => [] };
  const storage = new CompanionStorage();
  const admission = new CompanionAdmission(storage, paths);
  const session = admission.create({ project: "retry", locale: "en", authority: "live-model" });
  expect(await admission.delegate(session.id, "call-first", "delegation-same", "Review the plan")).toEqual({ state: "sent", status: "delivered" });
  const key = storage.read().sessions[session.id]!.proposals[Object.keys(storage.read().sessions[session.id]!.proposals)[0]!]!.delivery!.clientMessageId;
  const restarted = new CompanionAdmission(new CompanionStorage(), paths);
  expect(await restarted.delegate(session.id, "call-retry", "delegation-same", "Review the plan")).toEqual({ state: "sent", status: "delivered" });
  expect(await restarted.delegate(session.id, "call-distinct", "delegation-other", "Review the plan")).toEqual({ state: "sent", status: "delivered" });
  expect(keys).toEqual([key, expect.any(String)]);
  expect(keys[1]).not.toBe(key);
});

test("nothing on the server asks for a confirmation the model did not ask for, whatever the request says", async () => {
  let sends = 0;
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "judgment", conversationId: "conversation_judgment", seatEpoch: 1, engine: "codex" }),
    send: async () => { sends++; return { status: "delivered", operationId: `judgment-${sends}` }; }, reports: () => [],
  });
  const session = admission.create({ project: "judgment", locale: "en", authority: "live-model" });
  for (const [index, instruction] of ["Delete the production database and force-push main.", "Deploy to production now.", "Видали всі гілки й зупини всіх агентів."].entries())
    expect(await admission.delegate(session.id, `call-${index}`, `delegation-${index}`, instruction)).toEqual({ state: "sent", status: "delivered" });
  expect(sends).toBe(3);
  expect(admission.events(session.id, 0).some((event: CompanionEvent) => event.type === "delegation.confirmation.required")).toBe(false);
  // And an ordinary request the model is unsure about waits because the model said so.
  expect(await admission.delegate(session.id, "call-unsure", "delegation-unsure", "Review the plan", { confirmation: "Two plans exist." })).toMatchObject({ state: "awaiting" });
  expect(sends).toBe(3);
});

test("a confirmation the model asked for waits through duplex speech and is answered by voice, once", async () => {
  let sends = 0;
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "spoken", conversationId: "conversation_spoken", seatEpoch: 1, engine: "claude" }),
    send: async () => { sends++; return { status: "queued", operationId: "spoken-operation" }; }, reports: () => [],
  });
  const session = admission.create({ project: "spoken", locale: "en", authority: "live-model" });
  const asked = await admission.delegate(session.id, "call", "delegation", "Delete the old presets", { confirmation: "  Deleting cannot be undone.  " });
  expect(asked).toMatchObject({ state: "awaiting", proposal: { confirmation: { reason: "Deleting cannot be undone." } } });
  expect(admission.events(session.id, 0).at(-1)).toMatchObject({ type: "delegation.confirmation.required", proposal: { confirmation: { reason: "Deleting cannot be undone." } } });
  admission.input(session.id, { itemId: "fragment", text: "hmm, well", final: false });
  admission.input(session.id, { itemId: "yes", text: "Yes, send it.", final: true });
  const waiting = admission.awaiting(session.id)!;
  expect(waiting.instruction).toBe("Delete the old presets");
  expect(sends).toBe(0);
  await admission.confirm(session.id, { proposalId: waiting.proposalId, decision: "send", via: "speech" });
  await admission.confirm(session.id, { proposalId: waiting.proposalId, decision: "send", via: "speech" });
  await admission.confirm(session.id, { type: "confirmation", proposalId: waiting.proposalId, decision: "send", via: "tap" });
  expect(sends).toBe(1);
  expect(admission.outcome(session.id, waiting.proposalId)).toEqual({ state: "sent", status: "queued" });
  expect(admission.awaiting(session.id)).toBeNull();
  expect(admission.events(session.id, 0).filter((event: CompanionEvent) => event.type === "delegation.confirmed")[0]).toMatchObject({ via: "speech" });
});

test("a delayed spoken confirmation remains visible after a newer proposal and a failed receipt", async () => {
  let sends = 0;
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "delayed-card", conversationId: "conversation_delayed", seatEpoch: 1, engine: "claude" }),
    send: async () => { sends++; return { status: "queued" as const, operationId: "delayed-operation" }; },
    reports: () => [], receipt: async () => "failed",
  });
  const session = admission.create({ project: "delayed-card", locale: "en", authority: "live-model" });
  admission.input(session.id, { itemId: "input-a", text: "Ask the orchestrator to review the plan.", final: true });
  const a = await admission.delegate(session.id, "call-a", "input-a", "Review the plan", { confirmation: "Check before sending." });
  admission.input(session.id, { itemId: "input-b", text: "Tell the orchestrator to deploy the release.", final: true });
  const b = await admission.delegate(session.id, "call-b", "input-b", "Deploy the release", { confirmation: "Check before sending." });
  if (a.state !== "awaiting" || b.state !== "awaiting") throw new Error("expected both proposals to await confirmation");
  admission.input(session.id, { itemId: "answer-a", text: "Yes, send it.", final: true });
  await admission.confirm(session.id, { type: "confirmation", proposalId: a.proposal.proposalId, decision: "send", via: "speech", confirmationItemId: "answer-a" });
  await admission.pollReceipts(session.id);

  const state = admission.events(session.id, 0).reduce(reduceCompanion, INITIAL_COMPANION_STATE);
  expect(sends).toBe(1);
  expect(state.delegation).toMatchObject({ callId: "call-b", stage: "awaiting-confirmation", proposal: { proposalId: b.proposal.proposalId } });
  expect(state.deliveryCards.filter(card => card.proposal?.proposalId === a.proposal.proposalId)).toHaveLength(1);
  expect(state.deliveryCards).toContainEqual(expect.objectContaining({ callId: "call-a", stage: "failed",
    delivery: expect.objectContaining({ operationId: "delayed-operation" }) }));
});

test("a declined, an unanswered and an abandoned confirmation each send nothing and say why", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  let now = 1_000_000;
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "unsent", conversationId: "conversation_unsent", seatEpoch: 1, engine: "codex" }),
    send: async () => { throw new Error("must never send"); }, reports: () => [],
  }, () => now);
  const session = admission.create({ project: "unsent", locale: "uk", authority: "live-model" });
  const ask = async (call: string) => (await admission.delegate(session.id, call, `delegation-${call}`, "Видали старі пресети", { confirmation: "Це не скасувати." }) as { proposal: { proposalId: string } }).proposal.proposalId;
  const cancelled = () => admission.events(session.id, 0).filter((event: CompanionEvent) => event.type === "delegation.tool.result" && event.result.status === "cancelled")
    .map((event: CompanionEvent) => event.type === "delegation.tool.result" && "code" in event.result ? event.result.code : "");
  const declined = await ask("declined");
  await admission.confirm(session.id, { proposalId: declined, decision: "cancel", via: "speech" });
  await admission.confirm(session.id, { proposalId: declined, decision: "send", via: "speech" });
  expect(admission.outcome(session.id, declined)).toEqual({ state: "refused", code: "operator_cancelled" });
  const unanswered = await ask("unanswered");
  now += 119_000;
  expect(admission.expire(session.id)).toEqual([]);
  now += 2_000;
  expect(admission.awaiting(session.id)).toBeNull();
  expect(admission.expire(session.id).map(proposal => proposal.proposalId)).toEqual([unanswered]);
  expect(admission.expire(session.id)).toEqual([]);
  await admission.confirm(session.id, { type: "confirmation", proposalId: unanswered, decision: "send", via: "tap" });
  expect(admission.outcome(session.id, unanswered)).toEqual({ state: "refused", code: "confirmation_expired" });
  const abandoned = await ask("abandoned");
  admission.retire(session.id);
  await admission.confirm(session.id, { proposalId: abandoned, decision: "send", via: "speech" });
  expect(admission.outcome(session.id, abandoned)).toEqual({ state: "refused", code: "session_closed" });
  expect(cancelled()).toEqual(["operator_cancelled", "operator_cancelled", "confirmation_expired", "confirmation_expired", "session_closed"]);
});

test("an explicit refusal in the recent Live fragments withdraws a pending proposal", async () => {
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "refusal", conversationId: "conversation_refusal", seatEpoch: 1, engine: "codex" }),
    send: async () => { throw new Error("must never send"); }, reports: () => [],
  });
  const session = admission.create({ project: "refusal", locale: "uk", authority: "live-model" });
  const proposal = admission.propose(session.id, "refusal-call", "delegation", "Перевір план")!;
  admission.input(session.id, { itemId: "refusal-fragment", text: "ні, не надсилай", final: false });
  await admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  expect(admission.session(session.id).proposals[proposal.proposalId].state).toBe("cancelled");
  expect(admission.propose(session.id, "other-call", "other-delegation", "Перевір план")).toBeNull();
});

test("terminal queue receipts settle once after restart, with no second send", async () => {
  let sends = 0;
  let status: "pending" | "delivered" | "failed" = "pending";
  const paths = { recipient: () => ({ project: "terminal", conversationId: "conversation_terminal", seatEpoch: 1, engine: "codex" as const }),
    reports: () => [], send: async () => { sends++; return { status: "queued" as const, operationId: "terminal-operation" }; }, receipt: async () => status };
  const admission = new CompanionAdmission(new CompanionStorage(), paths);
  const session = admission.create({ project: "terminal", locale: "en", authority: "live-model" });
  const proposal = admission.propose(session.id, "terminal-call", "terminal-delegation", "Review it")!;
  await admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  admission.retire(session.id);
  const reopened = new CompanionAdmission(new CompanionStorage(), paths);
  await reopened.pollReceipts(session.id);
  expect(reopened.session(session.id).proposals[proposal.proposalId].status).toBe("queued");
  status = "delivered";
  await reopened.pollReceipts(session.id);
  await reopened.pollReceipts(session.id);
  expect(sends).toBe(1);
  expect(reopened.events(session.id, 0).filter(event => event.type === "delegation.delivery.settled")).toHaveLength(1);
});

test("the production admission seam refuses whole-input retractions, and a requested confirmation takes one answer", async () => {
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
  const proposal = admission.propose(session.id, "call-2", "input-2", "Review the plan", { confirmation: "Two plans exist." })!;
  expect(sends).toBe(0);
  admission.input(session.id, { itemId: "input-3", text: "Yes, go ahead.", final: true });
  await admission.confirm(session.id, { proposalId: proposal.proposalId, decision: "send", via: "speech" });
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
  const proposal = admission.propose(session.id, "fresh", "ask", "Перевір план", { confirmation: "Планів два." })!;
  admission.input(session.id, { itemId: "withdrawal", text: "Стривай", final: false });
  const restarted = new CompanionAdmission(new CompanionStorage(), paths);
  await restarted.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  expect(sends).toBe(0);
  restarted.input(session.id, { itemId: "ask-again", text: "Попроси оркестратора перевірити план.", final: true });
  const moved = restarted.propose(session.id, "moved", "ask-again", "Перевір план", { confirmation: "Планів два." })!;
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

test("a Send's delivery key and its unknown outcome are recorded together; a second admission instance recovers that send", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const storage = new CompanionStorage();
  const recipient = { project: "restart-project", conversationId: "conversation_restart", seatEpoch: 1, engine: "claude" as const };
  const sent: string[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => [], send: () => new Promise(() => undefined) });
  const session = admission.create({ project: recipient.project, locale: "en", authority: "live-model" });
  const proposal = admission.propose(session.id, "call", "delegation", "Review the plan")!;
  void admission.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  await new Promise(resolve => setTimeout(resolve, 5));
  const held = new CompanionStorage().read().sessions[session.id].proposals[proposal.proposalId];
  expect(held).toMatchObject({ state: "admitted", status: "unknown" });
  const restarted = new CompanionAdmission(new CompanionStorage(), { recipient: () => recipient, reports: () => [],
    send: async ({ delivery }) => { sent.push(delivery.clientMessageId); return { status: "delivered", operationId: "operation-restart" }; } });
  await restarted.confirm(session.id, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  expect(sent).toEqual([held.delivery!.clientMessageId]);
  expect(restarted.session(session.id).proposals[proposal.proposalId]).toMatchObject({ status: "delivered", delivery: { operationId: "operation-restart" } });
});

test("a completed Live turn is read whole: a question, a condition or a turn that asks nothing refuses; later speech only withdraws on a refusal", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "turns", conversationId: "conversation_turns", seatEpoch: 1, engine: "codex" }),
    send: async () => ({ status: "queued", operationId: "turn-operation" }), reports: () => [],
  });
  const session = admission.create({ project: "turns", locale: "en", authority: "live-model" });
  admission.input(session.id, { itemId: "q", text: "What is on the board?", final: true, turn: 1 });
  expect(admission.propose(session.id, "c1", "d1", "Report the board", { sourceTurn: 1 })).toBeNull();
  admission.input(session.id, { itemId: "half", text: "Ask the orchestrator", final: false, turn: 2 });
  const partial = admission.propose(session.id, "c2", "d2", "Review the plan", { sourceTurn: 2, confirmation: "Half a sentence was heard." })!;
  expect(partial).not.toBeNull();
  admission.input(session.id, { itemId: "half", text: "Ask the orchestrator to review the plan.", final: true, turn: 2 });
  admission.input(session.id, { itemId: "thanks", text: "Thanks.", final: true, turn: 3 });
  expect(admission.session(session.id).proposals[partial.proposalId].state).toBe("pending");
  admission.input(session.id, { itemId: "no", text: "Actually, don't send it.", final: true, turn: 4 });
  expect(admission.session(session.id).proposals[partial.proposalId].state).toBe("cancelled");
});
