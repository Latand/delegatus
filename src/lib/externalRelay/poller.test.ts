import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { externalRelayTempRoot } from "./runner";
import { createOwnerRunDirectory } from "./runDirectory";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import {
  ensureExternalRelayPollers,
  refreshExternalRelayPollers,
  refreshRelayTargets,
  refreshRelayDescriptorFeatures,
  relayClaimCapabilities,
  refreshTargetsForRead,
  relayPollerStatus,
  stopExternalRelayPollers,
  sweepExternalRelayOrphans,
  waitForExternalRelayRuns,
  wakeExternalRelayPoller,
} from "./poller";
import { changeRun, dropRun, externalRelayFile, reserveRun, readRelayStore, readRunLedger, updateRelayStore, type PairedRelay, type RelayTargetSettings } from "./store";
import { startTestRelay } from "./testRelay";
import { noteRelayOutcome, noteRelayProgress } from "./activity";
import { contextRequest, sampleRequest } from "./request.fixture";
import { clonePairing, cloneReceipt } from "./clone.fixture";
import { cloneClientKey, type CloneSendInput } from "./cloneSend";
import { ownerTierFor } from "./profile";
import { requestSchema } from "./protocol";
import { ownerTurnDiagnostic } from "./diagnostic";
import { deliverOwnerLateAnswer } from "./ownerLateDelivery";
import { ownerRequestTimeoutText } from "./requestTimeout";
import { answerRecorder, pruneAnswerRecords, readAnswerRecord, relayAnswersRoot } from "./answers";
import { setRelaySwitch } from "./switches";
import { createRelaySteps } from "./progressSteps";
import { RELAY_MEDIA_ANY_DOCUMENT } from "./mediaInputValidation";
const root = fs.mkdtempSync(path.join(externalRelayTempRoot(), "relay-poller-test-"));
process.env.LLV_STATE_DIR = root;
const runDirs: string[] = [];

for (const prepared of [false, true]) for (const ukrainian of [false, true]) for (const uncertain of [false, true]) for (const status of [false, true]) for (const diagnosticOnly of [false, true])
test(`legacy unsent reply is safe once (prepared=${prepared}, uk=${ukrainian}, uncertain=${uncertain}, status=${status}, diagnosticOnly=${diagnosticOnly})`, async () => {
  const priorStore = readRelayStore();
  const sends: CloneSendInput[] = [];
  const server = await startTestRelay((req, payload) => {
    expect(req.url).toEndWith("/send");
    sends.push(payload as CloneSendInput);
    return uncertain ? { status: 409, body: { error: { code: "send_uncertain" } } } : { body: cloneReceipt() };
  });
  const relay = clonePairing(server.origin);
  relay.targets[0]!.ownerTier = true;
  relay.targets[0]!.enabled = true;
  const id = `legacy_failure_${prepared}_${ukrainian}_${uncertain}_${status}`;
  const text = ukrainian ? "Допоможи із запитом" : "Help with this request";
  const request = requestSchema.parse({ ...contextRequest, request_id: id, target_id: relay.targets[0]!.id,
    answer: { max_chars: 4000, progress: "none" },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true },
      conversation: [{ ...contextRequest.input.conversation[0], text }] } });
  const owner = ownerTierFor({ ownerTier: true }, request)!;
  const answer = { action: "reply" as const, text: "Failure: RelayStoreBusy: relay store is busy", reply_to: owner.messageId };
  const body = { lease_id: request.lease_id, outcome: "answered" as const,
    answer: status ? { ...answer, text: ownerRequestTimeoutText(4000) } : answer, duration_ms: 1000 };
  const delivery = { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: null };
  const payload: CloneSendInput = { chat_id: delivery.chat_id, reply_to_message_id: delivery.reply_to_message_id,
    client_key: cloneClientKey(relay.id, "owner-late-answer", id, 0), text: body.answer.text, parse_mode: null, silent: false };
  const storedPayload = status ? { ...payload, text: answer.text } : payload;
  const directory = fs.mkdtempSync(path.join(externalRelayTempRoot(), "legacy-failure-"));
  runDirs.push(directory);
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-04T12:02:00Z"));
  answerRecorder({ requestId: id, relayId: relay.id, targetId: request.target_id, targetName: null,
    claimedAt: request.claimed_at, input: request.input, features: request.features })!.begin("codex", null, { webSearch: true, owner: true });
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  reserveRun({ requestId: id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id,
    ownerPid: 999999999, ownerIdentity: "dead", childPid: null, childIdentity: null,
    startedAt: "2026-11-04T12:00:00Z", runDir: directory,
    ownerTurn: { clientAttemptId: `relay-owner-${id}`, ...(!prepared ? { rawRequest: request } : {}), context: owner,
      request: { text: owner.text, requestText: owner.requestText }, delivery,
      cancel: "kill", confirmed: true, diagnostic: ownerTurnDiagnostic("exception", answer.text),
      ...(!diagnosticOnly ? { failureReply: { answer, until: "2026-11-04T12:00:01Z" } } : {}),
      lateAnswer: { body, files: [], ...(prepared ? { payload: storedPayload, parts: [{ payload: storedPayload }] } : {}) } } });
  try {
    await sweepExternalRelayOrphans();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ ...payload, text: status ? ownerRequestTimeoutText(4000) : ukrainian
      ? "Не вдалося завершити запит. Спробуйте ще раз." : "Your request could not be completed. Please try again." });
    expect(readRunLedger().runs.some(row => row.requestId === id)).toBe(uncertain);
    if (!uncertain) expect(readAnswerRecord(relay.id, request.target_id, id)).toMatchObject({
      delivery: "accepted", answer: { text: sends[0]!.text } });
    if (uncertain) {
      const pending = readRunLedger().runs.find(row => row.requestId === id)!.ownerTurn!.lateAnswer!;
      expect(pending.status).toBe("uncertain");
      expect(pending.body).toMatchObject({ answer: { text: sends[0]!.text } });
      expect(pending.parts?.map(part => part.payload)).toEqual(sends);
      changeRun(id, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn!.lateAnswer!, nextAttemptAt: 0 } } }));
      expect(await deliverOwnerLateAnswer(relay, id, { ...body, answer: { ...answer, text: "Another payload" } }, [], () => true))
        .toMatchObject({ delivery: "unconfirmed", body: pending.body });
      expect(readRunLedger().runs.find(row => row.requestId === id)?.ownerTurn?.lateAnswer?.parts).toEqual(pending.parts);
    }
    await sweepExternalRelayOrphans();
    expect(sends).toHaveLength(1);
  } finally { clock.mockRestore(); dropRun(id); updateRelayStore(() => priorStore); await server.close(); }
});

for (const attempted of ["body", "part", "receipt", "uncertain", "uncertain-no-context"] as const)
test(`legacy failure with ${attempted} evidence never sends another payload or key`, async () => {
  const priorStore = readRelayStore();
  const sends: unknown[] = [];
  const server = await startTestRelay((_req, payload) => { sends.push(payload); return { body: cloneReceipt() }; });
  const relay = clonePairing(server.origin);
  relay.targets[0]!.ownerTier = true;
  relay.targets[0]!.enabled = true;
  const id = `legacy_attempted_${attempted}`;
  const request = requestSchema.parse({ ...contextRequest, request_id: id, target_id: relay.targets[0]!.id,
    answer: { max_chars: 4000, progress: "none" }, input: { ...contextRequest.input,
      requester: { ...contextRequest.input.requester, is_owner: true } } });
  const owner = ownerTierFor({ ownerTier: true }, request)!;
  const answer = { action: "reply" as const, text: "Failure: structured message text exceeds the 32000-byte envelope bound", reply_to: owner.messageId };
  const body = { lease_id: request.lease_id, outcome: "answered" as const, answer, duration_ms: 1000 };
  const delivery = { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: null };
  const payload: CloneSendInput = { chat_id: delivery.chat_id, reply_to_message_id: delivery.reply_to_message_id,
    client_key: cloneClientKey(relay.id, "owner-late-answer", id, 0), text: answer.text, parse_mode: null, silent: false };
  const directory = fs.mkdtempSync(path.join(externalRelayTempRoot(), "legacy-attempted-"));
  runDirs.push(directory);
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-04T12:02:00Z"));
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  reserveRun({ requestId: id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id,
    ownerPid: 999999999, ownerIdentity: "dead", childPid: null, childIdentity: null,
    startedAt: "2026-11-04T12:00:00Z", runDir: directory,
    ownerTurn: { clientAttemptId: `relay-owner-${id}`, rawRequest: request, context: owner,
      ...(attempted !== "uncertain-no-context" ? { delivery } : {}),
      cancel: "kill", confirmed: true, diagnostic: ownerTurnDiagnostic("exception", answer.text),
      failureReply: { answer, until: "2026-11-04T12:00:01Z" },
      lateAnswer: { body, files: [], ...(attempted === "uncertain-no-context" ? { status: "uncertain" as const } : { payload,
        ...(attempted === "body" ? { firstAttemptAt: Date.now() } : {}),
        ...(attempted === "uncertain" ? { status: "uncertain" as const } : {}),
        parts: [{ payload, ...(attempted === "part" ? { firstAttemptAt: Date.now() } : {}),
          ...(attempted === "receipt" ? { receipt: { kind: "sent" as const, messageId: 101, messageKey: "fixture_message_101", sentAt: Date.parse("2026-11-04T12:00:00Z"), replayed: false } } : {}) }] }) } } });
  try {
    const before = readRunLedger().runs.find(row => row.requestId === id)!.ownerTurn!.lateAnswer!;
    for (let replay = 0; replay < 2; replay++) {
      await sweepExternalRelayOrphans();
      const pending = readRunLedger().runs.find(row => row.requestId === id)?.ownerTurn?.lateAnswer;
      expect(pending).toEqual({ ...before, status: "uncertain" });
      expect(sends).toHaveLength(0);
      changeRun(id, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, delivery } }));
    }
  } finally { clock.mockRestore(); dropRun(id); updateRelayStore(() => priorStore); await server.close(); }
});
test("unreadable cancellation custody leaves relay settings accessible and preserves ledger bytes", () => {
  const file = externalRelayFile("runs");
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const content = "{broken fixture-private-content";
  const diagnostics: unknown[][] = [], oldError = console.error;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.error = (...args) => { diagnostics.push(args); };
  try {
    expect(relayPollerStatus("fixture-relay")).toMatchObject({ state: "paused", lastOutcome: "local_error" });
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(JSON.stringify(diagnostics)).toContain("custody unreadable");
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-private-content");
  } finally {
    console.error = oldError;
    if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true });
  }
});
afterAll(async () => {
  stopExternalRelayPollers();
  await waitForExternalRelayRuns();
  for (const dir of runDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("polling learns progress_steps within five minutes with owner tools OFF and ignores unknown features", async () => {
  const previous = readRelayStore().relays;
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let descriptorReads = 0;
  let heartbeat: unknown, completed = false;
  let releaseExtraClaim!: () => void;
  const extraClaim = new Promise<void>(resolve => { releaseExtraClaim = resolve; });
  const originalSelection = accountManager.resolveHeadlessSpawn;
  accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: null })) as typeof originalSelection;
  let features = ["requester_context"];
  const observed: { features: string[]; claim: unknown }[] = [];
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) { heartbeat = body; stopExternalRelayPollers(); releaseExtraClaim(); return { body: { status: "ok" } }; }
    if (req.url?.endsWith("/complete")) { completed = true; return { body: { status: "accepted", duplicate: false } }; }
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: "target_1", name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url === "/.well-known/delegatus-relay.json") {
      descriptorReads++;
      return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "",
        api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, features } };
    }
    if (observed.length >= 3) { await extraClaim; return { status: 204 }; }
    observed.push({ features: readRelayStore().relays[0]!.features ?? [], claim: body });
    if (observed.length === 1) {
      features = ["requester_context", "progress_steps", "future_feature", "relay_owner_tools"];
      now += 299_999;
    } else if (observed.length === 2) now++;
    else return { body: { request: { ...sampleRequest, request_id: "loop-progress-claim" } } };
    return { status: 204 };
  });
  try {
    setRelaySwitch("relay:owner_tools:enabled", false);
    updateRelayStore(store => ({ ...store, relays: [{ id: "progress_refresh", origin: server.origin,
      api_base: `${server.origin}/v1`, name: "Test", description: "", credential: "x".repeat(43),
      owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
      pairedAt: "2026-01-01T00:00:00Z", paused: false, targets: [{ id: "target_1", name: "Target",
        answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low",
        project: null, concurrency: 1, hardCapMinutes: 1 }], features: ["requester_context"],
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } }] }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 400 && !completed; i++) await Bun.sleep(5);
    expect(observed).toHaveLength(3);
    expect(descriptorReads).toBe(2);
    expect(observed.map(row => row.features)).toEqual([["requester_context"], ["requester_context"], features]);
    for (const row of observed) expect(row.claim).toEqual({ wait_s: 25, kinds: ["answer"],
      features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"], slots: [{ target_id: "target_1", free: 1 }] });
    expect(completed).toBe(true);
    expect(heartbeat).toMatchObject({ seq: 1, progress: { kind: "step", label: "accepted" } });
  } finally {
    stopExternalRelayPollers(); releaseExtraClaim(); clock.mockRestore(); accountManager.resolveHeadlessSpawn = originalSelection;
    updateRelayStore(store => ({ ...store, relays: previous }));
    await server.close();
  }
});

test("an unknown-feature 4xx refreshes the descriptor before five minutes with owner tools OFF", async () => {
  const previous = readRelayStore().relays;
  let descriptorReads = 0, claims = 0;
  let features = ["requester_context"];
  const server = await startTestRelay(req => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [] } };
    if (req.url === "/.well-known/delegatus-relay.json") {
      descriptorReads++;
      return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "",
        api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, features } };
    }
    if (++claims === 1) {
      features = ["requester_context", "progress_steps"];
      return { status: 400, body: { error: { code: "unknown_feature" } } };
    }
    stopExternalRelayPollers();
    return { status: 204 };
  });
  try {
    setRelaySwitch("relay:owner_tools:enabled", false);
    updateRelayStore(store => ({ ...store, relays: [{ id: "unknown_feature_refresh", origin: server.origin,
      api_base: `${server.origin}/v1`, name: "Test", description: "", credential: "x".repeat(43),
      owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
      pairedAt: "2026-01-01T00:00:00Z", paused: false, targets: [],
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } }] }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 200 && claims < 2; i++) await Bun.sleep(5);
    expect(descriptorReads).toBe(2);
    expect(claims).toBe(2);
    expect(readRelayStore().relays[0]!.features).toEqual(features);
  } finally {
    stopExternalRelayPollers(); updateRelayStore(store => ({ ...store, relays: previous })); await server.close();
  }
});

test("a heartbeat unknown-feature refusal refreshes cached features before the next claim", async () => {
  const previous = readRelayStore().relays;
  const originalSelection = accountManager.resolveHeadlessSpawn;
  accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: null })) as typeof originalSelection;
  let descriptorReads = 0, claims = 0, heartbeats = 0;
  let releaseRefreshed!: () => void;
  const refreshed = new Promise<void>(resolve => { releaseRefreshed = resolve; });
  let featuresAtNextClaim: string[] | undefined;
  let features: string[] = [];
  const server = await startTestRelay(async (req) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [
      { target_id: "target_1", name: "Target", answered_by: "install", fallback: "service" },
    ] } };
    if (req.url === "/.well-known/delegatus-relay.json") {
      descriptorReads++;
      if (descriptorReads === 2) releaseRefreshed();
      return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "",
        api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, features } };
    }
    if (req.url?.endsWith("/heartbeat")) {
      heartbeats++;
      features = ["progress_steps"];
      return { status: 400, body: { error: { code: "unknown_feature" } } };
    }
    if (req.url?.endsWith("/complete")) return { body: { status: "ok" } };
    if (req.url?.endsWith("/requests/claim")) {
      claims++;
      if (claims === 1) return { body: { request: { ...sampleRequest, request_id: "heartbeat-unknown-feature" } } };
      await Promise.race([refreshed, Bun.sleep(100)]);
      for (let i = 0; i < 20 && !readRelayStore().relays[0]!.features?.includes("progress_steps"); i++) await Bun.sleep(5);
      featuresAtNextClaim ??= readRelayStore().relays[0]!.features;
      stopExternalRelayPollers();
    }
    return { status: 204 };
  });
  try {
    setRelaySwitch("relay:owner_tools:enabled", false);
    updateRelayStore(store => ({ ...store, relays: [{ id: "heartbeat_unknown_feature", origin: server.origin,
      api_base: `${server.origin}/v1`, name: "Test", description: "", credential: "x".repeat(43),
      owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
      pairedAt: "2026-01-01T00:00:00Z", paused: false, targets: [{ id: "target_1", name: "Target",
        answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low",
        project: null, concurrency: 1, hardCapMinutes: 1 }], features: [],
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } }] }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 400 && (claims < 2 || descriptorReads < 2 || featuresAtNextClaim === undefined); i++) await Bun.sleep(5);
    expect(heartbeats).toBe(1);
    expect(claims).toBeGreaterThanOrEqual(2);
    expect(descriptorReads).toBe(2);
    expect(featuresAtNextClaim).toEqual(["progress_steps"]);
    expect(readRelayStore().relays[0]!.features).toEqual(["progress_steps"]);
  } finally {
    stopExternalRelayPollers();
    accountManager.resolveHeadlessSpawn = originalSelection;
    updateRelayStore(store => ({ ...store, relays: previous }));
    await server.close();
  }
});

test("F4 requires the local switch and latest descriptor, and refresh removes withdrawn features", async () => {
  let features = ["requester_context", "relay_tool_calls", "relay_tool_actions", "relay_owner_tools"];
  let descriptorReads = 0;
  const server = await startTestRelay(() => {
    descriptorReads++;
    return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "Test",
      api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, features } };
  });
  const paired: PairedRelay = { id: "features", origin: server.origin, api_base: `${server.origin}/v1`, name: "Test", description: "",
    credential: "x".repeat(43), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: "2026-01-01T00:00:00Z", paused: true, targets: [], limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } };
  const before = JSON.stringify(relayClaimCapabilities(paired));
  try {
    updateRelayStore((store) => ({ ...store, relays: [paired] }));
    await refreshRelayDescriptorFeatures(paired.id);
    let current = readRelayStore().relays[0]!;
    expect(current.features).toEqual(features);
    expect(JSON.stringify(relayClaimCapabilities(current))).toBe(before);
    setRelaySwitch("relay:owner_tools:enabled", true);
    expect(relayClaimCapabilities(current).features.at(-1)).toBe("relay_owner_tools");
    expect(relayClaimCapabilities(paired).features).not.toContain("relay_owner_tools");
    expect(await refreshRelayDescriptorFeatures(paired.id, 300_000)).toBe("skipped");
    expect(descriptorReads).toBe(1);
    features = ["requester_context", "relay_tool_calls", "relay_tool_actions"];
    await refreshRelayDescriptorFeatures(paired.id);
    current = readRelayStore().relays[0]!;
    expect(current.features).toEqual(features);
    expect(relayClaimCapabilities(current).features).not.toContain("relay_owner_tools");
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); await server.close(); }
});

test("a forced descriptor refresh preserves newly discovered features after an older read completes", async () => {
  const previous = readRelayStore().relays;
  let descriptorReads = 0;
  let releaseOrdinary!: () => void;
  let releaseForced!: () => void;
  let ordinaryStarted!: () => void;
  let forcedStarted!: () => void;
  const ordinaryGate = new Promise<void>(resolve => { releaseOrdinary = resolve; });
  const forcedGate = new Promise<void>(resolve => { releaseForced = resolve; });
  const ordinarySeen = new Promise<void>(resolve => { ordinaryStarted = resolve; });
  const forcedSeen = new Promise<void>(resolve => { forcedStarted = resolve; });
  const server = await startTestRelay(async req => {
    if (req.url !== "/.well-known/delegatus-relay.json") return { status: 404 };
    descriptorReads++;
    if (descriptorReads === 1) {
      ordinaryStarted();
      await ordinaryGate;
      return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "",
        api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, features: [] } };
    }
    forcedStarted();
    await forcedGate;
    return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "",
      api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, features: ["progress_steps"] } };
  });
  const relay: PairedRelay = { id: "descriptor_overlap", origin: server.origin, api_base: `${server.origin}/v1`, name: "Test",
    description: "", credential: "x".repeat(43), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: "2026-01-01T00:00:00Z", paused: true, targets: [], features: [],
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } };
  try {
    setRelaySwitch("relay:owner_tools:enabled", false);
    updateRelayStore(store => ({ ...store, relays: [relay] }));
    const ordinary = refreshRelayDescriptorFeatures(relay.id);
    await ordinarySeen;
    const forced = refreshRelayDescriptorFeatures(relay.id, 0, { force: true });
    await Bun.sleep(20);
    expect(descriptorReads).toBe(1);
    releaseOrdinary();
    await ordinary;
    await forcedSeen;
    releaseForced();
    await forced;

    const current = readRelayStore().relays[0]!;
    expect(descriptorReads).toBe(2);
    expect(current.features).toEqual(["progress_steps"]);
    expect(createRelaySteps(current.features)).not.toBeNull();
    expect(relayClaimCapabilities(current).features).not.toContain("relay_owner_tools");
  } finally {
    releaseOrdinary();
    releaseForced();
    updateRelayStore(store => ({ ...store, relays: previous }));
    await server.close();
  }
});

test("the real claim loop adds F4 after descriptor refresh only while the local switch is ON", async () => {
  const previous = readRelayStore().relays;
  try {
    for (const enabled of [false, true]) {
      const order: string[] = [];
      let claim: unknown;
      const server = await startTestRelay((req, body) => {
        if (req.url?.endsWith("/targets")) { order.push("targets"); return { body: { targets: [] } }; }
        if (req.url === "/.well-known/delegatus-relay.json") {
          order.push("descriptor");
          return { body: { protocol: "delegatus-relay", versions: [1], name: "Test", description: "",
            api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: sampleRequest.liveness,
            limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
            features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "relay_owner_tools"] } };
        }
        order.push("claim"); claim = body; stopExternalRelayPollers(); return { status: 204 };
      });
      try {
        setRelaySwitch("relay:owner_tools:enabled", enabled);
        updateRelayStore((store) => ({ ...store, relays: [{ id: `owner_loop_${enabled}`, origin: server.origin,
          api_base: `${server.origin}/v1`, name: "Test", description: "", credential: "x".repeat(43),
          owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
          pairedAt: "2026-01-01T00:00:00Z", paused: false, targets: [],
          limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } }] }));
        ensureExternalRelayPollers();
        const deadline = Date.now() + 2000;
        while (!claim && Date.now() < deadline) await Bun.sleep(5);
        expect(order).toEqual(["targets", "descriptor", "claim"]);
        expect(claim).toEqual({ wait_s: 25, kinds: ["answer"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline",
          ...(enabled ? ["relay_owner_tools"] : [])], slots: [] });
      } finally { stopExternalRelayPollers(); await server.close(); }
    }
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); updateRelayStore((store) => ({ ...store, relays: previous })); }
});
for (const location of ["temporary", "shared-home"] as const)
test(`boot sweep settles dead owners, keeps live owners, and removes ${location} run directories`, async () => {
  let completed = 0;
  const server = await startTestRelay(
    () => (completed++, { body: { status: "accepted", duplicate: false } }),
  );
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [
        {
          id: "relay",
          origin: server.origin,
          api_base: `${server.origin}/v1`,
          name: "Test",
          description: "",
          credential: "x".repeat(43),
          owner: {
            namespace: "test",
            id: "owner",
            display_name: "Owner",
            handle: null,
          },
          pairedAt: new Date().toISOString(),
          paused: true,
          limits: {
            max_response_bytes: 1048576,
            max_wait_s: 25,
            max_answer_chars: 4000,
          },
          targets: [],
        },
      ],
    }));
    const staleDir = location === "shared-home" ? await createOwnerRunDirectory() : fs.mkdtempSync(
      path.join(externalRelayTempRoot(), "llv-external-relay-test-"),
    );
    const liveDir = location === "shared-home" ? await createOwnerRunDirectory() : fs.mkdtempSync(
      path.join(externalRelayTempRoot(), "llv-external-relay-test-"),
    );
    runDirs.push(staleDir, liveDir);
    for (const directory of [staleDir, liveDir]) fs.writeFileSync(path.join(directory, "owner-context.txt"), "Private quoted data", { mode: 0o600 });
    const row = {
      requestId: "stale",
      leaseId: "lease",
      relayId: "relay",
      targetId: "target",
      childPid: null,
      childIdentity: null,
      ownerPid: 999999999,
      ownerIdentity: "dead",
      runDir: staleDir,
      startedAt: new Date().toISOString(),
    };
    reserveRun(row);
    reserveRun({
      ...row,
      requestId: "live",
      ownerPid: process.pid,
      ownerIdentity: procBackend.processIdentity(process.pid),
      runDir: liveDir,
    });
    // Each run's answer record is open; only the dead owner's is settled.
    for (const requestId of ["stale", "live"])
      answerRecorder({ requestId, relayId: "relay", targetId: "target", targetName: null, claimedAt: null, input: { request_text: requestId } })!.begin("codex", "gpt-6-sol", { webSearch: true });
    await sweepExternalRelayOrphans();
    expect(readAnswerRecord("relay", "target", "stale")).toMatchObject({
      state: "finished", outcome: "failed:install_restarted", delivery: "accepted", input: { request_text: "stale" },
    });
    expect(readAnswerRecord("relay", "target", "live")).toMatchObject({ state: "running", outcome: null });
    expect(completed).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(liveDir)).toBe(true);
    expect(readRunLedger().runs.map((run) => run.requestId)).toEqual(["live"]);
  } finally {
    await server.close();
  }
});
test("orphan records distinguish terminal refusal from uncertain delivery and a removed pairing", async () => {
  const priorStore = readRelayStore();
  let status = 409;
  const server = await startTestRelay(() => ({ status, body: { error: { code: "unavailable", message: "No receipt" } } }));
  try {
    const paired = readRelayStore().relays[0]!;
    updateRelayStore((store) => ({ ...store, relays: [{ ...paired, api_base: `${server.origin}/v1` }] }));
    for (const code of [400, 401, 404, 409, 413, 426, 503, null]) {
      status = code ?? 503;
      if (code === null) updateRelayStore((store) => ({ ...store, relays: [] }));
      const requestId = `orphan_${code ?? "removed"}`;
      const runDir = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-test-"));
      runDirs.push(runDir);
      reserveRun({
        requestId, leaseId: "lease", relayId: "relay", targetId: "target",
        childPid: null, childIdentity: null, ownerPid: 999999999, ownerIdentity: "dead",
        runDir, startedAt: new Date().toISOString(),
      });
      answerRecorder({ requestId, relayId: "relay", targetId: "target", targetName: null, claimedAt: null, input: {} })!.begin("codex", "gpt-6-sol", { webSearch: true });
      await sweepExternalRelayOrphans();
      expect(readAnswerRecord("relay", "target", requestId)).toMatchObject({
        state: "finished", outcome: "failed:install_restarted",
        delivery: code === 503 || code === null ? "unconfirmed" : "refused",
      });
      expect(readRunLedger().runs.some((run) => run.requestId === requestId)).toBe(false);
      expect(fs.existsSync(runDir)).toBe(false);
    }
  } finally {
    updateRelayStore(() => priorStore);
    await server.close();
  }
});

test("a failed archive settlement is reconciled after the orphan ledger entry is dropped", async () => {
  const priorStore = readRelayStore();
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const originalWrite = fs.writeFileSync;
  const originalError = console.error;
  const errors: string[] = [];
  try {
    updateRelayStore((store) => ({ ...store, relays: [{ ...priorStore.relays[0]!, api_base: `${server.origin}/v1` }] }));
    const requestId = "orphan_write_failed";
    const runDir = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-test-"));
    runDirs.push(runDir);
    reserveRun({ requestId, leaseId: "lease", relayId: "relay", targetId: "target", childPid: null, childIdentity: null, ownerPid: 999999999, ownerIdentity: "dead", runDir, startedAt: new Date().toISOString() });
    answerRecorder({ requestId, relayId: "relay", targetId: "target", targetName: null, claimedAt: null, input: {} })!.begin("codex", "gpt-6-sol", { webSearch: true });
    console.error = (...args) => { errors.push(args.join(" ")); };
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).startsWith(relayAnswersRoot() + path.sep)) throw new Error("fixture archive write failed");
      return originalWrite(...args);
    }) as typeof fs.writeFileSync;
    await sweepExternalRelayOrphans();
    fs.writeFileSync = originalWrite;
    expect(errors.some((line) => line.startsWith("External relay answer record settle failed"))).toBe(true);
    expect(readRunLedger().runs.some((run) => run.requestId === requestId)).toBe(false);
    expect(readAnswerRecord("relay", "target", requestId)?.state).toBe("running");
    pruneAnswerRecords(Date.now(), () => readRunLedger().runs);
    expect(readAnswerRecord("relay", "target", requestId)).toMatchObject({ state: "finished", outcome: "failed:install_restarted", delivery: "unconfirmed" });
    expect(fs.existsSync(runDir)).toBe(false);
  } finally {
    fs.writeFileSync = originalWrite;
    console.error = originalError;
    updateRelayStore(() => priorStore);
    await server.close();
  }
});

test("staging never starts a claim loop", () => {
  process.env.LLV_STAGING = "1";
  try {
    ensureExternalRelayPollers();
  } finally {
    delete process.env.LLV_STAGING;
  }
});
for (const [status, code, expected] of [
  [401, "unauthorized", "credential_rejected"],
  [426, "unsupported_version", "unsupported_version"],
] as const)
  test(`${status} parks the claim loop`, async () => {
    const server = await startTestRelay(() => ({
      status,
      body: { error: { code, message: "refused" } },
    }));
    try {
      updateRelayStore((store) => ({
        ...store,
        relays: store.relays.map((relay) => ({
          ...relay,
          api_base: `${server.origin}/v1`,
          paused: false,
        })),
      }));
      ensureExternalRelayPollers();
      for (
        let i = 0;
        i < 30 && relayPollerStatus("relay").state !== expected;
        i++
      )
        await Bun.sleep(20);
      expect(relayPollerStatus("relay").state).toBe(expected);
    } finally {
      stopExternalRelayPollers();
      await server.close();
    }
  });
test("429 waits for Retry-After before another claim", async () => {
  let claims = 0;
  const server = await startTestRelay(
    (req) => (
      req.url?.endsWith("/requests/claim") && claims++,
      {
        status: 429,
        headers: { "retry-after": "1" },
        body: { error: { code: "rate_limited", message: "wait" } },
      }
    ),
  );
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({
        ...relay,
        api_base: `${server.origin}/v1`,
        paused: false,
      })),
    }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 30 && claims === 0; i++) await Bun.sleep(20);
    expect(claims).toBe(1);
    wakeExternalRelayPoller("relay");
    await Bun.sleep(250);
    expect(claims).toBe(1);
    await Bun.sleep(850);
    expect(claims).toBeGreaterThanOrEqual(2);
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
test("a refresh after receiving a claim completes its lease as declined", async () => {
  let claimAnswered = false;
  let refreshed = false;
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/requests/claim")) {
      if (claimAnswered) return { status: 204 };
      claimAnswered = true;
      return { body: { request: { ...sampleRequest, request_id: "rq_refresh" } } };
    }
    if (req.url?.endsWith("/complete")) {
      completions.push(body);
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404 };
  });
  const originalRead = fs.readFileSync;
  const originalRelays = readRelayStore().relays;
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{
        id: "refresh_relay", origin: server.origin, api_base: `${server.origin}/v1`,
        name: "Test", description: "", credential: "x".repeat(43),
        owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
        pairedAt: new Date().toISOString(), paused: false,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
        targets: [{
          id: "target_1", name: "Target", answered_by: "install", fallback: "service",
          enabled: true, engine: "codex", model: "gpt-6-sol", effort: "low",
          project: null, concurrency: 1, hardCapMinutes: 1,
        }],
      }],
    }));
    // Refresh at the store read between the received claim and dispatch.
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (claimAnswered && !refreshed && String(args[0]) === externalRelayFile("relays")) {
        refreshed = true;
        updateRelayStore((store) => ({
          ...store,
          relays: store.relays.map((relay) => ({ ...relay, paused: true })),
        }));
        refreshExternalRelayPollers("refresh_relay");
      }
      return originalRead(...args);
    }) as typeof fs.readFileSync;
    ensureExternalRelayPollers();
    for (let i = 0; i < 50 && completions.length === 0; i++) await Bun.sleep(20);
    expect(refreshed).toBe(true);
    expect(completions).toMatchObject([{ lease_id: sampleRequest.lease_id, outcome: "declined", reason: "disabled" }]);
  } finally {
    fs.readFileSync = originalRead;
    stopExternalRelayPollers();
    updateRelayStore((store) => ({ ...store, relays: originalRelays }));
    await server.close();
  }
});
test("route module copy controls the instrumentation poller", async () => {
  const routeCopy = await import("./poller.ts" + "?route-copy") as typeof import("./poller");
  const server = await startTestRelay(() => ({
    status: 401,
    body: { error: { code: "unauthorized", message: "refused" } },
  }));
  let changedClaims = 0;
  const changedServer = await startTestRelay(() => (
    changedClaims++,
    { status: 426, body: { error: { code: "unsupported_version", message: "upgrade" } } }
  ));
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({
        ...relay,
        api_base: `${server.origin}/v1`,
        paused: false,
      })),
    }));
    ensureExternalRelayPollers();
    for (
      let i = 0;
      i < 30 && relayPollerStatus("relay").state !== "credential_rejected";
      i++
    )
      await Bun.sleep(20);
    expect(routeCopy.relayPollerStatus("relay").state).toBe(
      "credential_rejected",
    );
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({ ...relay, paused: true })),
    }));
    routeCopy.refreshExternalRelayPollers("relay");
    expect(relayPollerStatus("relay").state).toBe("paused");
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({
        ...relay, api_base: `${changedServer.origin}/v1`, paused: false,
      })),
    }));
    routeCopy.refreshExternalRelayPollers("relay");
    for (
      let i = 0;
      i < 30 && relayPollerStatus("relay").state !== "unsupported_version";
      i++
    )
      await Bun.sleep(20);
    expect(relayPollerStatus("relay").state).toBe("unsupported_version");
    const priorClaims = changedClaims;
    updateRelayStore((store) => ({
      ...store,
      relays: [...store.relays, { ...store.relays[0], id: "new_relay" }],
    }));
    routeCopy.refreshExternalRelayPollers("new_relay");
    for (let i = 0; i < 30 && changedClaims === priorClaims; i++) await Bun.sleep(20);
    expect(changedClaims).toBeGreaterThan(priorClaims);
    expect(relayPollerStatus("new_relay").state).toBe("unsupported_version");
    updateRelayStore((store) => ({ ...store, relays: [] }));
    routeCopy.refreshExternalRelayPollers();
    expect(relayPollerStatus("relay").state).toBe("paused");
    expect(relayPollerStatus("new_relay").state).toBe("paused");
  } finally {
    routeCopy.stopExternalRelayPollers();
    await server.close();
    await changedServer.close();
  }
});
test("a corrupt run ledger logs the sweep failure and still starts polling", async () => {
  let claims = 0;
  // The targets read succeeds, so only the claim meets the 401.
  const server = await startTestRelay((req) => req.url?.endsWith("/targets")
    ? { body: { targets: [] } }
    : (
      claims++,
      { status: 401, body: { error: { code: "unauthorized", message: "refused" } } }
    ));
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{
        id: "corrupt_ledger", origin: server.origin, api_base: `${server.origin}/v1`,
        name: "Test", description: "", credential: "x".repeat(43),
        owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
        pairedAt: new Date().toISOString(), paused: false,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
        targets: [],
      }],
    }));
    fs.writeFileSync(externalRelayFile("runs"), "{broken");
    ensureExternalRelayPollers();
    for (let i = 0; i < 30 && errors.length === 0; i++) await Bun.sleep(20);
    expect(errors.some((error) => error.startsWith("External relay orphan sweep failed SyntaxError"))).toBe(true);
    expect(relayPollerStatus("corrupt_ledger").state).toBe("unreachable");
    fs.writeFileSync(externalRelayFile("runs"), '{"v":1,"runs":[]}');
    for (let i = 0; i < 60 && claims === 0; i++) await Bun.sleep(100);
    expect(claims).toBeGreaterThan(0);
  } finally {
    console.error = originalError;
    fs.writeFileSync(externalRelayFile("runs"), '{"v":1,"runs":[]}');
    stopExternalRelayPollers();
    await server.close();
  }
}, 10_000);
test("the last outcome and progress outlive a poll loop restarted by a settings change", async () => {
  const server = await startTestRelay(() => ({ status: 204 }));
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({ ...relay, api_base: `${server.origin}/v1`, paused: false })),
    }));
    const id = readRelayStore().relays[0]!.id;
    ensureExternalRelayPollers();
    noteRelayOutcome(id, "declined:busy");
    noteRelayProgress(id, "target_1", { kind: "note", label: "Reading the thread", tool: null, status: null, at: "2026-09-28T10:00:00.000Z" });
    refreshExternalRelayPollers(id);
    expect(relayPollerStatus(id)).toMatchObject({
      lastOutcome: "declined:busy",
      lastProgress: { targetId: "target_1", label: "Reading the thread" },
    });
    expect(relayPollerStatus(id).lastOutcomeAt).not.toBeNull();
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
const configured = (id: string, name = id): RelayTargetSettings => ({
  id, name, answered_by: "install", fallback: "service", enabled: true,
  engine: "codex", model: "gpt-6-sol", effort: "low", project: "repo-x",
  concurrency: 2, hardCapMinutes: 7,
});
function pairedRelay(id: string, origin: string, targets: RelayTargetSettings[]): PairedRelay {
  return {
    id, origin, api_base: `${origin}/v1`, name: "Test", description: "",
    credential: "x".repeat(43),
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: new Date().toISOString(), paused: false,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets,
  };
}
const storedTargets = (id: string) =>
  readRelayStore().relays.find((relay) => relay.id === id)?.targets;

test.each(["completion", "refresh", "stop"])("%s preserves a claim assigned to the poll already on the wire", async action => {
  const previous = readRelayStore().relays;
  const relayId = `claim-wake-${action}`;
  let entered!: () => void, release!: () => void, releaseNext!: () => void, settle!: (event: string) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const nextGate = new Promise<void>(resolve => { releaseNext = resolve; });
  const outcome = new Promise<string>(resolve => { settle = resolve; });
  const completions: unknown[] = [];
  let claims = 0;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [] } };
    if (req.url?.endsWith("/requests/claim")) {
      if (++claims > 1) { await nextGate; return { status: 204 }; }
      entered(); await gate;
      return { body: { request: { ...sampleRequest, request_id: `claim-after-${action}-wake` } } };
    }
    if (req.url?.endsWith("/complete")) {
      completions.push(body); settle("completed"); stopExternalRelayPollers(); releaseNext();
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404 };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    updateRelayStore(store => ({ ...store, relays: [pairedRelay(relayId, server.origin, [])] }));
    ensureExternalRelayPollers();
    await Promise.race([waiting, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("claim did not start")), 3000); })]);
    clearTimeout(timer);
    if (action === "completion") wakeExternalRelayPoller(relayId);
    else if (action === "refresh") refreshExternalRelayPollers(relayId);
    else stopExternalRelayPollers();
    release();
    expect(await Promise.race([outcome, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("claim was lost")), 3000); })])).toBe("completed");
    expect(completions).toMatchObject([{ lease_id: sampleRequest.lease_id, outcome: "declined", reason: "not_configured" }]);
  } finally {
    clearTimeout(timer); release(); stopExternalRelayPollers(); releaseNext();
    updateRelayStore(store => ({ ...store, relays: previous }));
    await server.close();
  }
});
test("the claim loop refreshes targets first, merges them, and advertises slots from the new list", async () => {
  const slots: unknown[] = [];
  const features: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/targets"))
      return { body: { targets: [
        { target_id: "kept", name: "Renamed", answered_by: "install", fallback: "none" },
        { target_id: "added", name: "New", answered_by: "service", fallback: "service" },
      ] } };
    if (req.url?.endsWith("/requests/claim")) {
      slots.push((body as { slots: unknown }).slots);
      features.push((body as { features?: unknown }).features);
      return { status: 204 };
    }
    return { status: 404 };
  });
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [pairedRelay("loop_refresh", server.origin, [configured("kept"), configured("gone")])],
    }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 50 && slots.length === 0; i++) await Bun.sleep(20);
    expect(storedTargets("loop_refresh")).toEqual([
      { ...configured("kept"), name: "Renamed", fallback: "none" },
      {
        id: "added", name: "New", answered_by: "service", fallback: "service",
        enabled: true, engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: null,
        concurrency: 1, hardCapMinutes: 30,
      },
    ]);
    // "gone" is no longer offered and "added" remains routed to the service.
    expect(slots[0]).toEqual([{ target_id: "kept", free: 2 }, { target_id: "added", free: 1 }]);
    // The claim lists what this install implements (§A.2 rule 11).
    expect(features[0]).toEqual(["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"]);
    expect(relayPollerStatus("loop_refresh").state).toBe("polling");
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
test("a settings read refreshes at most once per interval and joins a refresh on the wire", async () => {
  let reads = 0;
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const server = await startTestRelay(async (req) => {
    if (!req.url?.endsWith("/targets")) return { status: 404 };
    reads++;
    if (gate) await gate;
    return { body: { targets: [
      { target_id: "kept", name: "Kept", answered_by: "install", fallback: "service" },
    ] } };
  });
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{ ...pairedRelay("rate_limited_read", server.origin, [configured("kept", "Kept")]), paused: true }],
    }));
    await refreshTargetsForRead();
    expect(reads).toBe(1);
    await refreshTargetsForRead();
    expect(await refreshRelayTargets("rate_limited_read", 30_000)).toBe("skipped");
    expect(reads).toBe(1);
    gate = new Promise((resolve) => { release = resolve; });
    const first = refreshRelayTargets("rate_limited_read");
    const joined = refreshRelayTargets("rate_limited_read");
    expect(joined).toBe(first);
    release();
    expect(await first).toBe("unchanged");
    expect(reads).toBe(2);
    expect(storedTargets("rate_limited_read")).toEqual([configured("kept", "Kept")]);
  } finally {
    await server.close();
  }
});
test("a 401 on the targets read parks the claim loop as credential_rejected", async () => {
  let claims = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/requests/claim")) claims++;
    return { status: 401, body: { error: { code: "unauthorized", message: "revoked" } } };
  });
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [pairedRelay("rejected_targets", server.origin, [configured("kept")])],
    }));
    ensureExternalRelayPollers();
    for (
      let i = 0;
      i < 50 && relayPollerStatus("rejected_targets").state !== "credential_rejected";
      i++
    )
      await Bun.sleep(20);
    expect(relayPollerStatus("rejected_targets").state).toBe("credential_rejected");
    await Bun.sleep(100);
    expect(claims).toBe(0);
    expect(storedTargets("rejected_targets")).toEqual([configured("kept")]);
    expect(await refreshRelayTargets("rejected_targets")).toBe("credential_rejected");
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
test("a 5xx, an invalid body or a network error keeps the stored targets and says so on the activity line", async () => {
  let reply: { status?: number; body?: unknown } = { status: 503 };
  const server = await startTestRelay(() => reply);
  const kept = [configured("kept"), configured("other")];
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{ ...pairedRelay("failing_targets", server.origin, kept), paused: true }],
    }));
    expect(await refreshRelayTargets("failing_targets")).toBe("failed");
    expect(storedTargets("failing_targets")).toEqual(kept);
    expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:unreachable");
    for (const body of [{ targets: [{ target_id: "kept" }] }, { targets: "none" }]) {
      reply = { body };
      expect(await refreshRelayTargets("failing_targets")).toBe("failed");
      expect(storedTargets("failing_targets")).toEqual(kept);
      expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:malformed");
    }
    reply = { status: 429, body: { error: { code: "rate_limited", message: "wait" } } };
    expect(await refreshRelayTargets("failing_targets")).toBe("failed");
    expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:rate_limited");
  } finally {
    await server.close();
  }
  noteRelayOutcome("failing_targets", "answered");
  expect(await refreshRelayTargets("failing_targets")).toBe("failed");
  expect(storedTargets("failing_targets")).toEqual(kept);
  expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:unreachable");
  // An empty list from the service is a real answer: every target goes.
  const empty = await startTestRelay(() => ({ body: { targets: [] } }));
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) =>
        relay.id === "failing_targets" ? { ...relay, api_base: `${empty.origin}/v1` } : relay),
    }));
    expect(await refreshRelayTargets("failing_targets")).toBe("changed");
    expect(storedTargets("failing_targets")).toEqual([]);
  } finally {
    await empty.close();
  }
});


test("a claim already waiting when drain begins is held until its busy bound without reserving an answer", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  let entered!: () => void, release!: () => void, completed!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  const completions: unknown[] = [], slots: unknown[] = [];
  let claimed = false;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: "target_1", name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url?.endsWith("/requests/claim")) {
      slots.push((body as { slots: unknown }).slots);
      if (claimed) return { status: 204 };
      claimed = true; entered(); await gate;
      return { body: { request: { ...sampleRequest, request_id: "rq_waiting_drain", deadline_at: new Date(Date.now() + 14000).toISOString() } } };
    }
    if (req.url?.endsWith("/complete")) { completions.push(body); completed(); return { body: { status: "accepted", duplicate: false } }; }
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    return { status: 404 };
  });
  const originalRelays = readRelayStore().relays;
  const resolve = accountManager.resolveHeadlessSpawn;
  accountManager.resolveHeadlessSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env } } });
  try {
    updateRelayStore(store => ({ ...store, relays: [pairedRelay("drain_claim", server.origin, [configured("target_1")])] }));
    ensureExternalRelayPollers();
    await waiting;
    expect(slots[0]).toEqual([{ target_id: "target_1", free: 2 }]);
    writeDrain(drainFile(), { id: "claim-wait", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    release(); await done;
    expect(completions).toMatchObject([{ outcome: "declined", reason: "busy" }]);
    expect(readRunLedger().runs).toEqual([]);
    for (let i = 0; i < 100 && slots.length < 2; i++) await Bun.sleep(20);
    expect(slots[1]).toEqual([{ target_id: "target_1", free: 0 }]);
  } finally { accountManager.resolveHeadlessSpawn = resolve; release(); stopExternalRelayPollers(); releaseDrain(drainFile(), "claim-wait"); updateRelayStore(store => ({ ...store, relays: originalRelays })); await server.close(); }
});


test("chain and legacy local switches never advertise an unagreed wire feature", () => {
  const file = path.join(root, "external-relay/switches.json");
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, chat_conversations: true, chain_conversations: true, compact: true }));
    expect(relayClaimCapabilities()).toEqual({ kinds: ["answer", "compact"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"] });
    setRelaySwitch("compact", false); expect(relayClaimCapabilities().kinds).toEqual(["answer"]);
  } finally { if (previous) fs.writeFileSync(file, previous); else fs.rmSync(file, { force: true }); }
});

test("claim advertises on-demand tools only when the stored descriptor offers them", () => {
  expect(relayClaimCapabilities({ features: ["relay_tool_calls", "relay_tools_on_demand"] }).features).toContain("relay_tools_on_demand");
  expect(relayClaimCapabilities({ features: ["relay_tool_calls"] }).features).not.toContain("relay_tools_on_demand");
  expect(relayClaimCapabilities().features).not.toContain("relay_tools_on_demand");
});

test("inbound media is advertised only when the descriptor offers it and includes requester context", () => {
  expect(relayClaimCapabilities({ features: ["relay_media_in"] }).features).toEqual(expect.arrayContaining(["relay_media_in", "requester_context"]));
  expect(relayClaimCapabilities({ features: [] }).features).not.toContain("relay_media_in");
});

test("any-document claims require both inbound capabilities in the descriptor", () => {
  expect(relayClaimCapabilities({ features: ["relay_media_in", RELAY_MEDIA_ANY_DOCUMENT] }).features)
    .toEqual(expect.arrayContaining(["relay_media_in", "requester_context", RELAY_MEDIA_ANY_DOCUMENT]));
  for (const features of [[], ["relay_media_in"], [RELAY_MEDIA_ANY_DOCUMENT]]) {
    expect(relayClaimCapabilities({ features }).features).not.toContain(RELAY_MEDIA_ANY_DOCUMENT);
  }
});

/** A retained owner row whose late answer never got a delivery context. */
function staleLateRow(relay: PairedRelay, id: string, startedAt: string, custody: "quarantined" | "confirmed", directory: string) {
  const at = new Date(Date.parse(startedAt) + 600_000).toISOString();
  const answer = { action: "reply" as const, text: "Fixture failure notice", reply_to: null };
  reserveRun({ requestId: id, leaseId: `lease-${id}`, relayId: relay.id, targetId: relay.targets[0]!.id,
    ownerPid: 999999999, ownerIdentity: "dead", childPid: null, childIdentity: null, startedAt, runDir: directory,
    capacityReleased: true,
    ownerTurn: { clientAttemptId: `relay-owner-${id}`, admissionComplete: true, cancelledAt: at,
      ...(custody === "quarantined" ? { cancel: "interrupt" as const, quarantinedAt: at } : { cancel: "kill" as const, confirmed: true }),
      released: { at, reason: "stop_unconfirmed" }, diagnostic: ownerTurnDiagnostic("launch", "fixture"),
      failureReply: { answer, until: at },
      lateAnswer: { body: { lease_id: `lease-${id}`, outcome: "answered", answer, duration_ms: 1000 }, files: [],
        clientKey: cloneClientKey(relay.id, "owner-late-answer", id, 0), status: "pending-delivery-context" } } });
}
const lateStatus = (id: string) => readRunLedger().runs.find(row => row.requestId === id)?.ownerTurn?.lateAnswer?.status;

test("late answers that can never be delivered are written off on the first sweep and keep their custody", async () => {
  const priorStore = readRelayStore();
  let sends = 0;
  const server = await startTestRelay(() => { sends++; return { body: cloneReceipt() }; });
  const relay = { ...clonePairing(server.origin), id: "stale-late-relay" };
  relay.targets[0]!.ownerTier = true;
  const paused = { ...clonePairing(server.origin), id: "stale-late-paused", paused: true };
  updateRelayStore(store => ({ ...store, relays: [relay, paused] }));
  const old = new Date(Date.now() - 17 * 24 * 60 * 60_000).toISOString();
  const ids = ["stale_quarantined", "stale_confirmed", "stale_paused"];
  const directories = ids.map(() => fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-stale-")));
  runDirs.push(...directories);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    staleLateRow(relay, ids[0]!, old, "quarantined", directories[0]!);
    staleLateRow(relay, ids[1]!, old, "confirmed", directories[1]!);
    staleLateRow(paused, ids[2]!, old, "confirmed", directories[2]!);
    answerRecorder({ requestId: ids[1]!, relayId: relay.id, targetId: relay.targets[0]!.id, targetName: null, claimedAt: null, input: null })!
      .begin("codex", null, { webSearch: true, owner: true });
    await sweepExternalRelayOrphans();
    expect(ids.map(lateStatus)).toEqual(["retry-expired", "retry-expired", "retry-expired"]);
    // The write-off is readable in the answer record as well as the ledger.
    expect(readAnswerRecord(relay.id, relay.targets[0]!.id, ids[1]!)).toMatchObject({ state: "finished", outcome: "failed:delivery_expired" });
    expect(relayPollerStatus(paused.id).alarm).toBeNull();
    const before = fs.statSync(externalRelayFile("runs")).ino;
    await sweepExternalRelayOrphans();
    // Terminal rows are neither retried nor rewritten, and nothing is deleted.
    expect(fs.statSync(externalRelayFile("runs")).ino).toBe(before);
    expect(ids.map(lateStatus)).toEqual(["retry-expired", "retry-expired", "retry-expired"]);
    expect(directories.every(directory => fs.existsSync(directory))).toBe(true);
    expect(readRunLedger().runs.find(row => row.requestId === ids[0])?.ownerTurn?.lateAnswer?.body).toMatchObject({ outcome: "answered" });
    expect(sends).toBe(0);
  } finally { log.mockRestore(); for (const id of ids) dropRun(id); updateRelayStore(() => priorStore); await server.close(); }
});

test("an unsent deliverable answer still reaches the owner after the install was off for days", async () => {
  const priorStore = readRelayStore();
  const sends: CloneSendInput[] = [];
  const server = await startTestRelay((req, payload) => { sends.push(payload as CloneSendInput); return { body: cloneReceipt() }; });
  const relay = { ...clonePairing(server.origin), id: "offline-late-relay" };
  relay.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const id = "offline_unsent";
  const request = requestSchema.parse({ ...contextRequest, request_id: id, target_id: relay.targets[0]!.id,
    answer: { max_chars: 4000, progress: "none" },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } });
  const owner = ownerTierFor({ ownerTier: true }, request)!;
  const answer = { action: "reply" as const, text: "Fixture failure notice", reply_to: owner.messageId };
  const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
  const directory = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-offline-"));
  runDirs.push(directory);
  try {
    reserveRun({ requestId: id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id,
      ownerPid: 999999999, ownerIdentity: "dead", childPid: null, childIdentity: null, startedAt, runDir: directory,
      ownerTurn: { clientAttemptId: `relay-owner-${id}`, rawRequest: request, context: owner,
        request: { text: owner.text, requestText: owner.requestText },
        delivery: { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: null },
        cancel: "kill", confirmed: true, diagnostic: ownerTurnDiagnostic("exception", "fixture"),
        failureReply: { answer, until: startedAt },
        lateAnswer: { body: { lease_id: request.lease_id, outcome: "answered", answer, duration_ms: 1000 }, files: [] } } });
    await sweepExternalRelayOrphans();
    expect(sends).toHaveLength(1);
    expect(readRunLedger().runs.some(row => row.requestId === id)).toBe(false);
  } finally { dropRun(id); updateRelayStore(() => priorStore); await server.close(); }
});

test("a settled terminal late answer is marked as holding no target slot, once", async () => {
  const priorStore = readRelayStore();
  const server = await startTestRelay(() => ({ body: cloneReceipt() }));
  const relay = { ...clonePairing(server.origin), id: "terminal-slot-relay" };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const directory = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-slot-"));
  runDirs.push(directory);
  try {
    staleLateRow(relay, "terminal_slot", new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(), "confirmed", directory);
    changeRun("terminal_slot", ({ capacityReleased: _released, ...row }) => ({ ...row,
      ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn!.lateAnswer!, status: "retry-expired" } } }));
    await sweepExternalRelayOrphans();
    expect(readRunLedger().runs.find(row => row.requestId === "terminal_slot")).toMatchObject({ capacityReleased: true,
      ownerTurn: { lateAnswer: { status: "retry-expired" } } });
    const before = fs.statSync(externalRelayFile("runs")).ino;
    await sweepExternalRelayOrphans();
    expect(fs.statSync(externalRelayFile("runs")).ino).toBe(before);
  } finally { dropRun("terminal_slot"); updateRelayStore(() => priorStore); await server.close(); }
});

test("a late answer inside its window keeps retrying and reports its alarm beside the last result", async () => {
  const priorStore = readRelayStore();
  const server = await startTestRelay(() => ({ body: cloneReceipt() }));
  const relay = { ...clonePairing(server.origin), id: "fresh-late-relay" };
  relay.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const directory = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-fresh-"));
  runDirs.push(directory);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    staleLateRow(relay, "fresh_late", new Date(Date.now() - 60 * 60_000).toISOString(), "confirmed", directory);
    noteRelayOutcome(relay.id, "answered");
    await sweepExternalRelayOrphans();
    expect(lateStatus("fresh_late")).toBe("pending-delivery-context");
    expect(relayPollerStatus(relay.id)).toMatchObject({ lastOutcome: "answered", alarm: "pending-delivery-context" });
  } finally { log.mockRestore(); dropRun("fresh_late"); updateRelayStore(() => priorStore); await server.close(); }
});

test("a terminal late answer inside its window is retained without another ledger write", async () => {
  const priorStore = readRelayStore();
  const server = await startTestRelay(() => ({ body: cloneReceipt() }));
  const relay = { ...clonePairing(server.origin), id: "terminal-late-relay" };
  relay.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const directory = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-terminal-"));
  runDirs.push(directory);
  try {
    staleLateRow(relay, "terminal_late", new Date(Date.now() - 60 * 60_000).toISOString(), "confirmed", directory);
    changeRun("terminal_late", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn!.lateAnswer!, status: "uncertain" } } }));
    const before = fs.statSync(externalRelayFile("runs")).ino;
    await sweepExternalRelayOrphans();
    expect(fs.statSync(externalRelayFile("runs")).ino).toBe(before);
    expect(lateStatus("terminal_late")).toBe("uncertain");
  } finally { dropRun("terminal_late"); updateRelayStore(() => priorStore); await server.close(); }
});
