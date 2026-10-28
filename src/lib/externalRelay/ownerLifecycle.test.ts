import fs from "node:fs";
import { expect, jest, spyOn, test } from "bun:test";
import type { EphemeralAgentResult } from "@/lib/agent/ephemeral";
import { accountManager } from "@/lib/accounts/manager";
import * as client from "./client";
import { runClaimedRequest } from "./runner";
import { contextRequest } from "./request.fixture";
import { updateRelayStore, type PairedRelay } from "./store";
import { setRelaySwitch } from "./switches";

import { startTestRelay } from "./testRelay";
import { cloneReceipt } from "./clone.fixture";
const delivery = { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: 12 };
const flush = () => { jest.advanceTimersByTime(1); return fs.promises.stat(process.cwd()).then(() => {}); };

function setupRelay(): PairedRelay {
  const relay: PairedRelay = { id: "owner_lifecycle", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1",
    name: "Fixture", description: "", credential: "fixture", owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: new Date().toISOString(), paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "none", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 30, ownerTier: true }] };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", false);
  return relay;
}

for (const media of [false, true]) test(`owner outlives the service deadline and delivers one late answer (files: ${media})`, async () => {
  const epoch = Date.now();
  let now = epoch;
  const relay = setupRelay();
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const { createHash } = await import("node:crypto");
  const attachments = await import("./attachments");
  const { richRequest } = await import("./rich.fixture");
  const { relayAnswerOp } = await import("./ownerAnswer");
  const file = `${process.env.TMPDIR}/owner-late-file.txt`;
  await fs.promises.writeFile(file, "Saved report");
  const bytes = await fs.promises.readFile(file);
  const staged = { id: "late_file", file, filename: "report.txt", mime: "text/plain", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), kind: "document" as const, caption: "Report" };
  const stage = media ? spyOn(attachments, "stageOwnerAttachments").mockResolvedValue([staged]) : null;
  const posts: string[] = [];
  const deliveries: { headers: import("node:http").IncomingHttpHeaders; body: unknown }[] = [];
  const service = await startTestRelay((req, body) => {
    const endpoint = req.url!.replace("/api/relay/v1", "");
    posts.push(endpoint);
    if (endpoint.endsWith("/send")) {
      deliveries.push({ headers: req.headers, body });
      return { body: cloneReceipt() };
    }
    const method = req.method;
    if (method === "PUT") return { status: 201, body: { attachment_id: staged.id, filename: staged.filename,
      mime_type: staged.mime, byte_size: staged.size, sha256: staged.sha256, expires_at: new Date(now + 60000).toISOString() } } as never;
    if (endpoint.endsWith("/heartbeat") && now >= epoch + 120000) return { status: 409, body: { error: { code: "lease_lost" } } };
    return { status: 200, body: { status: "ok" } };
  });
  jest.useFakeTimers();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  let release!: () => void, observing = false, ended = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stops: string[] = [];
  const source = media ? richRequest(true) : contextRequest;
  const pending = runClaimedRequest(relay, { ...source, request_id: `owner_late_${media}`, deadline_at: new Date(epoch + 120000).toISOString(), owner_delivery: delivery,
    input: { ...source.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined,
  { leaseWorker: false, ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_late", initialMessage: "delivered" } }),
    observe: async () => { observing = true; await gate;
      if (media) expect(await relayAnswerOp("conversation_late", { attachments: [{ path: file, kind: "document" }] })).not.toBeNull();
      return { state: "ended", finalText: "Finished" }; }, stop: async (_id, action) => { stops.push(action); } } });
  void pending.finally(() => { ended = true; });
  try {
    for (let i = 0; i < 2000 && !observing && !ended; i++) await flush();
    expect(observing).toBe(true);
    now += 121000; jest.advanceTimersByTime(121000);
    for (let i = 0; i < 30; i++) await flush();
    expect(stops).toEqual([]);
    expect(ended).toBe(false);
    release();
    expect(await pending).toMatchObject({ outcome: "answered", answer: { text: "Finished" } });
    expect(posts.filter(p => p.endsWith("/send"))).toHaveLength(1);
    expect(deliveries[0]?.headers.authorization).toBe(`Bearer ${relay.credential}`);
    expect(deliveries[0]?.headers["delegatus-relay-version"]).toBe("1");
    expect(deliveries[0]?.body).toMatchObject({ ...delivery, parse_mode: null, silent: false,
      text: media ? "Finished\n\n[Files were produced; late delivery supports text only, so files are omitted.]" : "Finished" });
    expect(posts.filter(p => p.endsWith("/complete"))).toHaveLength(0);
    expect(posts.filter(p => p.includes("/attachments/"))).toHaveLength(0);
  } finally {
    release(); await pending;
    stage?.mockRestore(); await fs.promises.rm(file, { force: true });
    selection.mockRestore(); clock.mockRestore(); jest.useRealTimers(); await service.close();
  }
});

test("agent_error preserves the failing step and exit code without a transcript", async () => {
  const ephemeral = await import("@/lib/agent/ephemeral");
  const { readAnswerRecord } = await import("./answers");
  const relay = setupRelay();
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const launch = spyOn(ephemeral, "runEphemeralAgent").mockResolvedValue({ pid: null, identity: null, cancel() {},
    done: Promise.resolve({ status: "failed", answer: null, code: 17, signal: null, durationMs: 0 }) });
  const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await runClaimedRequest(relay, { ...contextRequest, request_id: "failed_exit", input: { ...contextRequest.input, tools: [] } }, undefined, { leaseWorker: false });
    expect(result).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(readAnswerRecord(relay.id, "target_1", "failed_exit")?.diagnostic).toMatchObject({ source: "observation", exitCode: 17 });
    expect(log.mock.calls.some(args => String(args[1]).includes('"exitCode":17'))).toBe(true);
  } finally { selected.mockRestore(); launch.mockRestore(); wire.mockRestore(); log.mockRestore(); }
});

for (const legacy of [false, true]) test(`restart retries once from ${legacy ? "legacy" : "current"} durable context and answers late`, async () => {
  const { reserveRun, readRunLedger } = await import("./store");
  const { sweepExternalRelayOrphans } = await import("./poller");
  const { ownerTierFor } = await import("./profile");
  const { requestSchema } = await import("./protocol");
  const { relayRequestInFlight } = await import("./runner");
  const relay = setupRelay();
  const raw = { ...contextRequest, request_id: `restarted_owner_${legacy}`, deadline_at: new Date(Date.now() - 1000).toISOString(), owner_delivery: delivery,
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const request = requestSchema.parse(raw);
  const owner = ownerTierFor(relay.targets[0]!, request)!;
  if (legacy) {
    const { answerRecorder } = await import("./answers");
    answerRecorder({ requestId: request.request_id, relayId: relay.id, targetId: request.target_id,
      targetName: "Target", claimedAt: request.claimed_at, chatKey: null, requester: request.input.requester ?? null,
      input: request.input })?.begin("codex", "auto", { owner: true, webSearch: true });
  }
  const dir = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  reserveRun({ requestId: request.request_id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id,
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: dir,
    startedAt: new Date(Date.now() - 20000).toISOString(), conversationId: "conversation_old",
    ownerTurn: { clientAttemptId: `relay-owner-${request.request_id}`, ...(legacy ? {} : { rawRequest: raw, context: owner, delivery }), request: owner, admissionComplete: true } }, 1);
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const posts: string[] = [], launches: string[] = [], stops: string[] = [];
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route) => { posts.push(route); return { status: 200, body: route.endsWith("/send") ? cloneReceipt() : { status: "ok" } } as never; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ports = { launch: async (body: Record<string, unknown>) => { launches.push(String(body.clientAttemptId)); return { status: 202, body: { conversationId: "conversation_retry", initialMessage: "delivered" } }; },
    observe: async () => { await gate; return { state: "ended" as const, finalText: "Done" }; }, stop: async (id: string) => { stops.push(id); } };
  try {
    await sweepExternalRelayOrphans(ports);
    for (let i = 0; i < 2000 && !launches.length; i++) await fs.promises.stat(dir);
    expect(launches).toEqual([`relay-owner-${request.request_id}-retry`]);
    expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.restartRetries).toBe(1);
    await sweepExternalRelayOrphans(ports);
    expect(launches).toHaveLength(1);
    release();
    for (let i = 0; i < 2000 && relayRequestInFlight(request.request_id); i++) await fs.promises.stat(process.cwd());
    await sweepExternalRelayOrphans(ports);
    expect(stops).toEqual(["conversation_old"]);
    expect(posts.filter(route => route.endsWith("/send"))).toHaveLength(legacy ? 0 : 1);
    expect(posts.some(route => route.endsWith("/complete"))).toBe(false);
    if (legacy) expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.lateAnswer?.status).toBe("pending-delivery-context");
    else expect(readRunLedger().runs.find(row => row.requestId === request.request_id)).toBeUndefined();
  } finally {
    release();
    for (let i = 0; i < 2000 && relayRequestInFlight(request.request_id); i++) await fs.promises.stat(process.cwd());
    selected.mockRestore(); wire.mockRestore();
    const { dropRun } = await import("./store"); dropRun(request.request_id);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("member still loses execution when the service deadline closes", async () => {
  const ephemeral = await import("@/lib/agent/ephemeral");
  const relay = setupRelay();
  jest.useFakeTimers();
  const epoch = Date.now();
  let now = epoch, launched = false, cancelled = false;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let resolve!: (value: EphemeralAgentResult) => void;
  const done = new Promise<EphemeralAgentResult>(r => { resolve = r; });
  const launch = spyOn(ephemeral, "runEphemeralAgent").mockImplementation(async input => {
    launched = true;
    expect(input.hardCapMs).toBe(30 * 60000);
    return { pid: null, identity: null, done, cancel() { cancelled = true; resolve({ status: "cancelled", answer: null, code: null, signal: null, durationMs: now - epoch }); } };
  });
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const posts: string[] = [];
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route) => {
    posts.push(route);
    if (route.endsWith("/heartbeat") && now >= epoch + 120000) throw new client.ExternalRelayError("lease_lost", 409);
    return { status: 200, body: { status: "ok" } } as never;
  });
  const pending = runClaimedRequest(relay, { ...contextRequest, request_id: "member_deadline", owner_delivery: delivery, deadline_at: new Date(epoch + 120000).toISOString(),
    input: { ...contextRequest.input, tools: [] } }, undefined, { leaseWorker: false });
  try {
    for (let i = 0; i < 2000 && !launched; i++) await flush();
    expect(launched).toBe(true);
    now += 120001; jest.advanceTimersByTime(120001);
    for (let i = 0; i < 30; i++) await flush();
    expect(cancelled).toBe(true);
    expect(await pending).toBeNull();
    expect(posts.some(route => route.endsWith("/send"))).toBe(false);
  } finally {
    resolve({ status: "cancelled", answer: null, code: null, signal: null, durationMs: 0 }); await pending;
    launch.mockRestore(); selection.mockRestore(); wire.mockRestore(); clock.mockRestore(); jest.useRealTimers();
  }
});

test("unsupported late delivery stays durable and startup retries the same answer", async () => {
  const { reserveRun, readRunLedger } = await import("./store");
  const { sweepExternalRelayOrphans } = await import("./poller");
  const relay = setupRelay();
  const { answerRecorder, readAnswerRecord } = await import("./answers");
  const recorder = answerRecorder({ requestId: "pending_late", relayId: relay.id, targetId: "target_1",
    targetName: "Target", claimedAt: null, chatKey: null, requester: null, input: {} });
  recorder?.finish({ outcome: "answered", answer: { action: "reply", text: "Saved answer", reply_to: "m1" }, delivery: "refused" });
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  const body = { outcome: "answered" as const, lease_id: "fixture", duration_ms: 200000,
    answer: { action: "reply" as const, text: "Saved answer", reply_to: "m1" } };
  reserveRun({ requestId: "pending_late", leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: directory,
    startedAt: new Date().toISOString(), capacityReleased: true,
    ownerTurn: { clientAttemptId: "relay-owner-pending_late", delivery, lateAnswer: { body, files: [] } } }, 1);
  const payloads: unknown[] = [];
  let supported = false;
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route, _method, payload) => {
    expect(route).toBe("/targets/target_1/send"); payloads.push(payload);
    if (!supported) throw new client.ExternalRelayError("not_found", 404);
    return { status: 200, body: cloneReceipt() } as never;
  });
  try {
    await sweepExternalRelayOrphans();
    expect(readRunLedger().runs.find(row => row.requestId === "pending_late")?.ownerTurn?.lateAnswer?.body).toEqual(body);
    expect(fs.existsSync(directory)).toBe(true);
    supported = true;
    const { changeRun } = await import("./store");
    changeRun("pending_late", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn!.lateAnswer!, nextAttemptAt: 0 } } }));
    await sweepExternalRelayOrphans();
    expect(payloads).toHaveLength(2); expect(payloads[0]).toEqual(payloads[1]);
    expect(readAnswerRecord(relay.id, "target_1", "pending_late")?.delivery).toBe("accepted");
    expect(readRunLedger().runs.find(row => row.requestId === "pending_late")).toBeUndefined();
    expect(fs.existsSync(directory)).toBe(false);
  } finally { wire.mockRestore(); }
});

test("a pre-transcript spawn exception is retained in the record and journal", async () => {
  const ephemeral = await import("@/lib/agent/ephemeral");
  const { readAnswerRecord } = await import("./answers");
  const relay = setupRelay();
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const launch = spyOn(ephemeral, "runEphemeralAgent").mockRejectedValue(new Error("simulated spawn admission refused"));
  const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runClaimedRequest(relay, { ...contextRequest, request_id: "spawn_exception", input: { ...contextRequest.input, tools: [] } }, undefined, { leaseWorker: false }))
      .toMatchObject({ outcome: "failed", reason: "agent_error", detail: null });
    expect(readAnswerRecord(relay.id, "target_1", "spawn_exception")?.diagnostic)
      .toEqual({ source: "launch", message: "Error: simulated spawn admission refused" });
    expect(log.mock.calls.some(args => String(args[1]).includes("simulated spawn admission refused"))).toBe(true);
  } finally { selection.mockRestore(); launch.mockRestore(); wire.mockRestore(); log.mockRestore(); }
});

test("a second restart reports failure without a second execution retry", async () => {
  const { reserveRun, readRunLedger } = await import("./store");
  const { sweepExternalRelayOrphans } = await import("./poller");
  const relay = setupRelay();
  const raw = { ...contextRequest, request_id: "retry_exhausted", input: { ...contextRequest.input, tools: [],
    requester: { ...contextRequest.input.requester, is_owner: true } } };
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  reserveRun({ requestId: raw.request_id, leaseId: raw.lease_id, relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: directory,
    startedAt: new Date().toISOString(), conversationId: "conversation_retry_old",
    ownerTurn: { clientAttemptId: "relay-owner-retry_exhausted-retry", restartRetries: 1, rawRequest: raw, delivery, admissionComplete: true } }, 1);
  let launches = 0;
  const answers: unknown[] = [];
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route, _method, body) => {
    expect(route).toBe("/targets/target_1/send"); answers.push(body);
    return { status: 200, body: cloneReceipt() } as never;
  });
  const ports = { launch: async () => { launches++; throw Error("unexpected second retry"); },
    observe: async () => ({ state: "ended" as const }), stop: async () => {} };
  try {
    await sweepExternalRelayOrphans(ports);
    await sweepExternalRelayOrphans(ports);
    expect(launches).toBe(0);
    expect(answers).toHaveLength(1);
    expect(readRunLedger().runs.find(row => row.requestId === raw.request_id)).toBeUndefined();
  } finally { wire.mockRestore(); }
});

test("an owner restart retry waits for existing target capacity", async () => {
  const { reserveRun, reserveRunAsync, dropRun } = await import("./store");
  const relay = setupRelay();
  const old = { requestId: "retry_capacity", leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: "",
    startedAt: new Date().toISOString(), ownerTurn: { clientAttemptId: "relay-owner-retry_capacity", confirmed: true } };
  reserveRun(old, 1);
  reserveRun({ ...old, requestId: "capacity_peer", ownerTurn: undefined }, 1);
  const retry = { ...old, ownerTurn: { clientAttemptId: "relay-owner-retry_capacity-retry", restartRetries: 1 as const } };
  try {
    expect(await reserveRunAsync(retry, 1, Date.now() + 1000, true)).toBe("full");
    dropRun("capacity_peer");
    expect(await reserveRunAsync(retry, 1, Date.now() + 1000, true)).toBe("added");
    expect(await reserveRunAsync(retry, 1, Date.now() + 1000)).toBe("duplicate");
  } finally { dropRun("retry_capacity"); dropRun("capacity_peer"); }
});

for (const interruptRetry of [false, true]) test(`real process restart preserves the one-retry budget (retry interrupted: ${interruptRetry})`, async () => {
  const { readRunLedger } = await import("./store");
  const relay = setupRelay();
  const sends: Record<string, unknown>[] = [];
  const service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/send")) {
      sends.push(body as Record<string, unknown>);
      return !interruptRetry && sends.length === 1 ? { status: 404, body: { error: { code: "not_found" } } } : { body: cloneReceipt() };
    }
    return { body: { status: "ok" } };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const request = { ...contextRequest, request_id: `process_restart_${interruptRetry}`,
    deadline_at: new Date(epoch + 120000).toISOString(), owner_delivery: delivery,
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/owner-process-`);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const runs: { reading: Promise<void>; errors: Promise<string> }[] = [];
  const bounded = async <T,>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("restart fixture exceeded parent deadline")), 20000);
    })]); } finally { clearTimeout(timer!); }
  };
  const launch = async (phase: string, index: number) => {
    const config = `${directory}/${index}.json`;
    await fs.promises.writeFile(config, JSON.stringify({ relay, request, phase, epoch: epoch + (index ? 121000 + (index - 1) * 31000 : 0) }));
    const child = Bun.spawn([process.execPath, "src/lib/externalRelay/ownerLifecycle.fixture.ts", config], {
      env: { ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    children.push(child);
    let ready!: () => void;
    const readiness = new Promise<void>(resolve => { ready = resolve; });
    let output = "";
    const reading = (async () => {
      const reader = child.stdout.getReader();
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break;
        output += Buffer.from(chunk.value).toString();
        if (output.includes("fixture-observing") || output.includes("fixture-finished")) ready();
      } } finally { reader.releaseLock(); }
    })();
    const errors = new Response(child.stderr).text(); runs.push({ reading, errors });
    await bounded(Promise.race([readiness, child.exited.then(code => { if (code) throw new Error(`fixture exited ${code}`); })]));
    return { child, reading, errors, output: () => output };
  };
  try {
    const first = await launch("start", 0);
    expect(first.output()).toContain(`fixture-launch:relay-owner-${request.request_id}`);
    expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.delivery).toEqual(delivery);
    first.child.kill("SIGKILL"); await bounded(first.child.exited); await first.reading;
    const retry = await launch(interruptRetry ? "hold" : "finish", 1);
    expect(retry.output()).toContain(`fixture-launch:relay-owner-${request.request_id}-retry`);
    if (interruptRetry) { retry.child.kill("SIGKILL"); await bounded(retry.child.exited); await retry.reading;
      expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.restartRetries).toBe(1);
      const last = await launch("finish", 2);
      expect(await bounded(last.child.exited)).toBe(0); await last.reading;
      expect(last.output()).not.toContain("fixture-launch:");
      // The first sweep stores the exhaustion answer; the next sends it.
      const final = await launch("finish", 3);
      expect(await bounded(final.child.exited)).toBe(0); await final.reading;
    } else {
      expect(await bounded(retry.child.exited)).toBe(0); await retry.reading;
      const saved = readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.lateAnswer;
      expect(sends[0]!.client_key).toBe(saved?.clientKey);
      expect(saved?.status).toBe("retry");
      const deliveryRetry = await launch("finish", 2);
      expect(await bounded(deliveryRetry.child.exited)).toBe(0); await deliveryRetry.reading;
      expect(deliveryRetry.output()).not.toContain("fixture-launch:");
      expect(sends[0]).toEqual(sends[1]);
    }
    expect(sends).toHaveLength(interruptRetry ? 1 : 2);
    expect(sends[0]).toMatchObject(delivery);
    expect(readRunLedger().runs.find(row => row.requestId === request.request_id)).toBeUndefined();
    if (!interruptRetry) expect(sends[0]!.text).toBe("Restart answer");
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    const stderr: string[] = [];
    for (const run of runs) { await run.reading; stderr.push(await run.errors); }
    const { dropRun } = await import("./store"); dropRun(request.request_id);
    await service.close(); await fs.promises.rm(directory, { recursive: true, force: true });
    for (const errors of stderr) expect(errors).not.toMatch(/error:|Unhandled|TypeError/);
  }
}, 60000);

test("a refused restart-budget write leaves the next sweep able to retry", async () => {
  const store = await import("./store");
  const { sweepExternalRelayOrphans } = await import("./poller");
  const { relayRequestInFlight } = await import("./runner");
  const relay = setupRelay();
  const raw = { ...contextRequest, request_id: "retry_write_refused", owner_delivery: delivery,
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const dir = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  store.reserveRun({ requestId: raw.request_id, leaseId: raw.lease_id, relayId: relay.id, targetId: raw.target_id,
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: dir,
    startedAt: "2026-10-24T15:00:00Z", conversationId: "conversation_write_refused",
    ownerTurn: { clientAttemptId: "relay-owner-retry_write_refused", rawRequest: raw, delivery, admissionComplete: true } }, 1);
  const change = store.changeRun;
  let refused = false, launches = 0;
  const writer = spyOn(store, "changeRun").mockImplementation((id, update, ...rest) => {
    const row = store.readRunLedger().runs.find(row => row.requestId === id);
    if (id === raw.request_id && !refused && row && update(row).ownerTurn?.restartRetries === 1) {
      refused = true; throw new Error("fixture restart-budget write refused");
    }
    return change(id, update, ...rest);
  });
  const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: cloneReceipt() } as never);
  const ports = { launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_retry_write", initialMessage: "delivered" } }; },
    observe: async () => ({ state: "ended" as const, finalText: "Done" }), stop: async () => {} };
  try {
    await expect(sweepExternalRelayOrphans(ports)).rejects.toThrow("fixture restart-budget write refused");
    expect(launches).toBe(0);
    await sweepExternalRelayOrphans(ports);
    for (let i = 0; i < 2000 && !launches; i++) await fs.promises.stat(dir);
    for (let i = 0; i < 2000 && relayRequestInFlight(raw.request_id); i++) await fs.promises.stat(process.cwd());
    expect(launches).toBe(1);
    expect(store.readRunLedger().runs.find(row => row.requestId === raw.request_id)).toBeUndefined();
  } finally { writer.mockRestore(); selected.mockRestore(); wire.mockRestore(); store.dropRun(raw.request_id); }
});

/** Restart the real recovery entry point against the same isolated ledger. */
async function deliveryProcess(directory: string, config: Record<string, unknown>, crashAfter?: Promise<void>) {
  const file = `${directory}/process.json`;
  await fs.promises.writeFile(file, JSON.stringify(config));
  const child = Bun.spawn([process.execPath, "src/lib/externalRelay/ownerLifecycle.fixture.ts", file], {
    env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = crashAfter ? (async () => {
      await Promise.race([crashAfter, child.exited.then(() => { throw new Error("fixture exited before crash seam"); })]);
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      return 0;
    })() : child.exited;
    expect(await Promise.race([finished, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("delivery fixture exceeded parent deadline")), 20000);
    })])).toBe(0);
    expect(await errors).not.toMatch(/error:|Unhandled|TypeError/);
    return await output;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited; await output; await errors;
  }
}

for (const timing of ["before", "after", "refusal"] as const) test(`owner handoff ${timing}: preserves its outcome through restart`, async () => {
  const late = timing !== "before";
  const { readRunLedger, changeRun, dropRun } = await import("./store");
  const { readAnswerRecord } = await import("./answers");
  const relay = setupRelay();
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/handoff-process-`);
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const clockFile = `${directory}/clock`;
  await fs.promises.writeFile(clockFile, String(epoch));
  const request = { ...contextRequest, request_id: `handoff_process_${timing}`, owner_delivery: delivery,
    deadline_at: new Date(epoch + 120000).toISOString(), answer: { ...contextRequest.answer, max_chars: 4000 },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } };
  const sends: { client_key: string; text: string }[] = [], visible = new Map<string, string>();
  const completions: unknown[] = [];
  let supported = false;
  const service = await startTestRelay(async (req, payload) => {
    if (req.url?.endsWith("/complete")) {
      completions.push(payload);
      if (timing === "refusal") await fs.promises.writeFile(clockFile, String(epoch + 121000));
      return late ? { status: 409, body: { error: { code: "lease_lost" } } } : { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/send")) {
      const body = payload as typeof sends[number]; sends.push(body);
      if (!supported) return { status: 404, body: { error: { code: "not_found" } } };
      visible.set(body.client_key, body.text); return { body: cloneReceipt() };
    }
    return { body: { status: "ok" } };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  try {
    await deliveryProcess(directory, { relay, request, epoch, clockFile, phase: "complete-now", finalText: "[handoff]",
      observedAt: epoch + (timing === "after" ? 121000 : 1000) });
    if (late) {
      const saved = readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.lateAnswer;
      expect(saved?.body).toMatchObject({ outcome: "answered", answer: { action: "reply" } });
      expect(saved?.body.outcome === "answered" && saved.body.answer.text).toMatch(/service window closed before the handoff/);
      expect(saved?.status).toBe("retry");
      expect(completions).toHaveLength(timing === "refusal" ? 1 : 0); expect(sends).toHaveLength(1); expect(visible.size).toBe(0);
      supported = true;
      changeRun(request.request_id, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn!.lateAnswer!, nextAttemptAt: 0 } } }));
      for (let restart = 0; restart < 2; restart++) {
        expect(await deliveryProcess(directory, { relay, request, epoch, clockFile, phase: "finish" })).not.toContain("fixture-launch:");
      }
      expect(completions).toHaveLength(timing === "refusal" ? 1 : 0); expect(sends).toHaveLength(2); expect(sends[1]).toEqual(sends[0]);
      expect([...visible.values()]).toEqual([sends[0]!.text]);
      expect(sends[0]).toMatchObject(delivery);
      expect(sends[0]!.text).toMatch(/Retry your request/);
      expect(readAnswerRecord(relay.id, "target_1", request.request_id)).toMatchObject({ outcome: "answered", delivery: "accepted",
        answer: { action: "reply", text: sends[0]!.text } });
    } else {
      expect(completions).toEqual([expect.objectContaining({ outcome: "declined", reason: "handoff" })]);
      expect(sends).toEqual([]);
    }
    expect(readRunLedger().runs.find(row => row.requestId === request.request_id)).toBeUndefined();
  } finally {
    const row = readRunLedger().runs.find(row => row.requestId === request.request_id);
    dropRun(request.request_id);
    if (row?.runDir) await fs.promises.rm(row.runDir, { recursive: true, force: true });
    await service.close(); await fs.promises.rm(directory, { recursive: true, force: true });
  }
}, 60000);

for (const phase of ["cap-recover", "cap-unresponsive", "cap-stalled"] as const)
test(`owner first-message hold in a child process: ${phase}`, async () => {
  const { readRunLedger, dropRun } = await import("./store");
  const { readAnswerRecord } = await import("./answers");
  const relay = setupRelay(); relay.targets[0]!.hardCapMinutes = 5000 / 60000;
  relay.features = ["progress_steps"];
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/cap-process-`);
  const controlFile = `${directory}/control`;
  await fs.promises.writeFile(controlFile, "hold");
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const request = { ...contextRequest, request_id: phase, owner_delivery: delivery,
    deadline_at: new Date(epoch + 120000).toISOString(), answer: { ...contextRequest.answer, max_chars: 4000 },
    liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 },
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const beats: { progress: { label: string } | null }[] = [];
  const service = await startTestRelay(async (req, payload) => {
    if (req.url?.endsWith("/heartbeat")) {
      const beat = payload as typeof beats[number]; beats.push(beat);
      if (phase === "cap-recover" && beat.progress?.label === "queued") await fs.promises.writeFile(controlFile, "finish");
    }
    return { body: { status: "ok" } };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const configFile = `${directory}/process.json`;
  await fs.promises.writeFile(configFile, JSON.stringify({ relay, request, epoch, phase, controlFile }));
  const child = Bun.spawn([process.execPath, "src/lib/externalRelay/ownerLifecycle.fixture.ts", configFile], {
    env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let output = "", ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const reading = (async () => {
    const reader = child.stdout.getReader();
    try { for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      output += Buffer.from(chunk.value).toString();
      if (output.includes(phase === "cap-stalled" ? "fixture-blocked" : "fixture-observing")) ready();
    } } finally { reader.releaseLock(); }
  })();
  const errors = new Response(child.stderr).text();
  const bounded = async <T,>(work: Promise<T>, ms: number, reason: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await bounded(Promise.race([readiness, child.exited.then(code => { throw new Error(`fixture exited before readiness: ${code}`); })]), 20000, "fixture startup deadline");
    const completion = bounded(child.exited, 15000, "owner cap exceeded parent deadline");
    if (phase === "cap-stalled") await expect(completion).rejects.toThrow("owner cap exceeded parent deadline");
    else {
      expect(await completion).toBe(0); await reading;
      expect(beats[0]?.progress?.label).toBe("accepted");
      expect(beats.some(beat => beat.progress?.label === "queued")).toBe(true);
      const record = readAnswerRecord(relay.id, "target_1", request.request_id);
      expect(record).toMatchObject({ outcome: "answered", delivery: "accepted", answer: { action: "reply" } });
      if (phase === "cap-recover") {
        expect(record?.answer?.text).toBe("Done"); expect(output).not.toContain("fixture-stop:");
      } else {
        expect(record?.diagnostic).toMatchObject({ source: "hard-cap", executionLimitMs: 5000 });
        expect(record?.answer?.text).toMatch(/execution time limit/);
        expect(output.match(/fixture-stop:kill/g)).toHaveLength(1);
      }
      expect(readRunLedger().runs.find(row => row.requestId === request.request_id)).toBeUndefined();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited; await reading;
    const stderr = await errors;
    const row = readRunLedger().runs.find(row => row.requestId === request.request_id);
    dropRun(request.request_id);
    if (row?.runDir) await fs.promises.rm(row.runDir, { recursive: true, force: true });
    await service.close(); await fs.promises.rm(directory, { recursive: true, force: true });
    expect(stderr).not.toMatch(/error:|Unhandled|TypeError/);
    if (phase === "cap-stalled") expect(child.signalCode).toBe("SIGKILL");
  }
}, 60000);

for (const response of ["crashed", "lost", "accepted", "refused", "already-completed"] as const)
test(`recovered failure completion ${response} survives restart and deadline without a duplicate`, async () => {
  const { readRunLedger, reserveRun, dropRun } = await import("./store");
  const { answerRecorder, readAnswerRecord } = await import("./answers");
  const relay = setupRelay();
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/orphan-completion-`);
  const runDir = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const request = { request_id: `orphan_completion_${response}` };
  const answer = { action: "reply" as const, text: "Saved failure", reply_to: "m1" };
  const clockFile = `${directory}/clock`;
  await fs.promises.writeFile(clockFile, String(epoch));
  let posted!: () => void, release!: () => void;
  const dispatch = new Promise<void>(resolve => { posted = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const visible: string[] = response === "already-completed" ? [answer.text] : [];
  const routes: string[] = [];
  let durableAtDispatch = false;
  const service = await startTestRelay(async (req, payload) => {
    const route = req.url!; routes.push(route);
    if (route.endsWith("/complete")) {
      durableAtDispatch = readRunLedger().runs.find(row => row.requestId === request.request_id)
        ?.ownerTurn?.completionAttempt?.body.outcome === "answered";
      await fs.promises.writeFile(clockFile, String(epoch + 3000));
      if (response === "refused" || response === "already-completed") return {
        status: 409, body: { error: { code: response === "refused" ? "lease_lost" : "already_completed" } },
      };
      visible.push((payload as { answer: { text: string } }).answer.text);
      posted();
      if (response === "crashed") await hold;
      return response === "lost" ? { drop: true } : { body: { status: "ok" } };
    }
    if (route.endsWith("/send")) { visible.push((payload as { text: string }).text); return { body: cloneReceipt() }; }
    return { body: { status: "ok" } };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const config = { relay, request, epoch, clockFile, phase: "finish" };
  answerRecorder({ requestId: request.request_id, relayId: relay.id, targetId: "target_1",
    targetName: "Target", claimedAt: null, chatKey: null, requester: null, input: {} })?.begin("codex", "auto", { owner: true, webSearch: true });
  reserveRun({ requestId: request.request_id, leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir,
    startedAt: new Date(epoch - 1000).toISOString(), ownerTurn: { clientAttemptId: `relay-owner-${request.request_id}`,
      cancel: "kill", confirmed: true, admissionComplete: true, delivery,
      diagnostic: { source: "launch", message: "Fixture launch refused" },
      failureReply: { answer, until: new Date(epoch + 2000).toISOString() } } }, 1);
  try {
    await deliveryProcess(directory, config, response === "crashed" ? dispatch : undefined);
    release();
    const uncertain = ["crashed", "lost", "already-completed"].includes(response);
    const beforeRestart = readRunLedger().runs.find(row => row.requestId === request.request_id);
    const retainedDirectory = fs.existsSync(runDir);
    for (let restart = 0; restart < 2; restart++) {
      expect(await deliveryProcess(directory, config)).not.toContain("fixture-launch:");
    }
    expect(visible).toEqual([answer.text]);
    expect(durableAtDispatch).toBe(true);
    expect(routes.filter(route => route.endsWith("/complete"))).toHaveLength(1);
    expect(routes.filter(route => route.endsWith("/send"))).toHaveLength(response === "refused" ? 1 : 0);
    const row = readRunLedger().runs.find(row => row.requestId === request.request_id);
    if (uncertain) {
      expect(beforeRestart?.ownerTurn?.completionAttempt?.body).toMatchObject({ outcome: "answered", answer });
      expect(beforeRestart?.completionAccepted).toBeUndefined();
      expect(beforeRestart?.ownerTurn?.lateAnswer).toBeUndefined();
      expect(retainedDirectory).toBe(true);
      expect(row?.ownerTurn?.completionAttempt).toBeDefined();
    }
    else {
      expect(row).toBeUndefined();
      expect(fs.existsSync(runDir)).toBe(false);
      expect(readAnswerRecord(relay.id, "target_1", request.request_id)).toMatchObject({ outcome: "answered", delivery: "accepted", answer });
    }
  } finally {
    release(); dropRun(request.request_id); await service.close();
    await fs.promises.rm(runDir, { recursive: true, force: true });
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}, 60000);

for (const response of ["lost", "accepted", "refused"] as const)
test(`normal completion ${response} across the deadline survives restart without a duplicate`, async () => {
  const { readRunLedger, dropRun } = await import("./store");
  const relay = setupRelay();
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/completion-process-`);
  const clockFile = `${directory}/clock`;
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  await fs.promises.writeFile(clockFile, String(epoch));
  const visible: string[] = [], routes: string[] = [];
  let durableAtDispatch = false;
  const service = await startTestRelay(async (req, payload) => {
    const route = req.url!; routes.push(route);
    if (route.endsWith("/complete")) {
      const completion = payload as { answer: { text: string } };
      durableAtDispatch = readRunLedger().runs.some(row => row.ownerTurn?.completionAttempt?.body.outcome === "answered");
      await fs.promises.writeFile(clockFile, String(epoch + 3000));
      if (response === "refused") return { status: 409, body: { error: { code: "lease_lost" } } };
      visible.push(completion.answer.text);
      return response === "lost" ? { drop: true } : { body: { status: "ok" } };
    }
    if (route.endsWith("/send")) { visible.push((payload as { text: string }).text); return { body: cloneReceipt() }; }
    return { body: { status: "ok" } };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const request = { ...contextRequest, request_id: `complete_${response}_restart`,
    deadline_at: new Date(epoch + 2000).toISOString(), owner_delivery: delivery,
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  const config = { relay, request, epoch, clockFile };
  try {
    await deliveryProcess(directory, { ...config, phase: "complete-now" });
    if (response === "lost") {
      const row = readRunLedger().runs.find(row => row.requestId === request.request_id);
      expect(row?.ownerTurn?.completionAttempt?.body).toMatchObject({ outcome: "answered", answer: { text: "Restart answer" } });
      expect(row?.ownerTurn?.lateAnswer).toBeUndefined();
    }
    for (let restart = 0; restart < 2; restart++) {
      expect(await deliveryProcess(directory, { ...config, phase: "finish" })).not.toContain("fixture-launch:");
    }
    expect(visible).toEqual(["Restart answer"]);
    expect(durableAtDispatch).toBe(true);
    expect(routes.filter(route => route.endsWith("/complete"))).toHaveLength(1);
    expect(routes.filter(route => route.endsWith("/send"))).toHaveLength(response === "refused" ? 1 : 0);
    if (response === "lost") expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.completionAttempt).toBeDefined();
    else expect(readRunLedger().runs.find(row => row.requestId === request.request_id)).toBeUndefined();
  } finally { dropRun(request.request_id); await service.close(); await fs.promises.rm(directory, { recursive: true, force: true }); }
}, 60000);

for (const state of ["confirmed", "quarantined"] as const) for (const expired of [false, true])
test(`released ${state} execution retains an unsent failure across process restarts (expired=${expired})`, async () => {
  const { reserveRun, readRunLedger, dropRun } = await import("./store");
  const relay = setupRelay();
  const epoch = Date.parse("2026-10-28T12:00:00Z");
  const request = { ...contextRequest, request_id: `released_failure_${state}_${expired}` };
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/released-failure-`);
  const clockFile = `${directory}/clock`;
  await fs.promises.writeFile(clockFile, String(epoch));
  const routes: string[] = [], bodies: unknown[] = [];
  const service = await startTestRelay((req, body) => { routes.push(req.url!); bodies.push(body); return { body: { status: "ok" } }; });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const answer = { action: "reply" as const, text: "Saved failure", reply_to: "m1" };
  reserveRun({ requestId: request.request_id, leaseId: request.lease_id, relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: directory,
    startedAt: new Date(epoch - 1000).toISOString(), capacityReleased: true,
    ownerTurn: { clientAttemptId: `relay-owner-${request.request_id}`, cancel: "kill", admissionComplete: true,
      ...(state === "confirmed" ? { confirmed: true } : { quarantinedAt: new Date(epoch).toISOString() }),
      released: { at: new Date(epoch).toISOString(), reason: state === "confirmed" ? "no_execution" : "stop_unconfirmed" },
      diagnostic: { source: "launch", message: "Fixture launch refused" },
      failureReply: { answer, until: new Date(epoch + (expired ? -1 : 60000)).toISOString() } } }, 1);
  try {
    for (let restart = 0; restart < 2; restart++) {
      const output = await deliveryProcess(directory, { relay, request, epoch, clockFile, phase: "finish" });
      expect(output).not.toContain("fixture-launch:");
      expect(output).not.toContain("fixture-stop:");
    }
    const saved = readRunLedger().runs.find(row => row.requestId === request.request_id)!;
    expect(saved.capacityReleased).toBe(true);
    expect(saved.ownerTurn?.failureReply?.answer).toEqual(answer);
    if (expired) {
      expect(routes).toEqual([]);
      expect(saved.ownerTurn?.lateAnswer).toMatchObject({ body: { answer }, status: "pending-delivery-context" });
    } else {
      expect(routes).toEqual([`/api/relay/v1/requests/${request.request_id}/complete`]);
      expect(bodies).toEqual([{ lease_id: request.lease_id, outcome: "answered", answer, duration_ms: 1000 }]);
      expect(saved.completionAccepted).toBe(true);
    }
  } finally { dropRun(request.request_id); await service.close(); await fs.promises.rm(directory, { recursive: true, force: true }); }
});

for (const seam of ["write-refused", "settlement-write-refused", "revoked", "competing-attempt", "competing-late-answer"] as const)
test(`orphan failure completion preserves custody at ${seam}`, async () => {
  const store = await import("./store");
  const { sweepExternalRelayOrphans } = await import("./poller");
  const relay = setupRelay();
  const requestId = `orphan_custody_${seam}`;
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const runDir = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  const body = { lease_id: "fixture", outcome: "answered" as const, duration_ms: 1000,
    answer: { action: "reply" as const, text: "Saved failure", reply_to: "m1" } };
  const posts: unknown[] = [], routes: string[] = [];
  const service = await startTestRelay((req, payload) => {
    posts.push(payload); routes.push(req.url!);
    return { body: req.url?.endsWith("/send") ? cloneReceipt() : { status: "ok" } };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(state => ({ ...state, relays: [relay] }));
  store.reserveRun({ requestId, leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir,
    startedAt: new Date(epoch - 1000).toISOString(), ownerTurn: { clientAttemptId: `relay-owner-${requestId}`,
      cancel: "kill", confirmed: true, admissionComplete: true, delivery,
      diagnostic: { source: "launch", message: "Fixture launch refused" },
      failureReply: { answer: body.answer, until: new Date(epoch + 60000).toISOString() } } }, 1);
  const clock = spyOn(Date, "now").mockReturnValue(epoch);
  const write = store.changeRunAsync;
  let intercepted = false;
  const writer = spyOn(store, "changeRunAsync").mockImplementation(async (id, update, until) => {
    const first = !intercepted; intercepted = true;
    if (first && seam === "write-refused") throw new Error("fixture completion custody write refused");
    if (!first && seam === "settlement-write-refused") throw new Error("fixture completion settlement write refused");
    if (first && seam === "competing-attempt") store.changeRun(requestId, row => ({ ...row,
      ownerTurn: { ...row.ownerTurn!, completionAttempt: { body, files: [] } } }));
    if (first && seam === "competing-late-answer") store.changeRun(requestId, row => ({ ...row,
      ownerTurn: { ...row.ownerTurn!, lateAnswer: { body, files: [] } } }));
    await write(id, update, until);
    if (first && seam === "revoked") updateRelayStore(state => ({ ...state,
      relays: state.relays.map(row => ({ ...row, paused: true })) }));
  });
  try {
    if (seam === "write-refused") await expect(sweepExternalRelayOrphans()).rejects.toThrow("fixture completion custody write refused");
    else if (seam === "settlement-write-refused") await expect(sweepExternalRelayOrphans()).rejects.toThrow("fixture completion settlement write refused");
    else await sweepExternalRelayOrphans();
    expect(posts).toEqual(seam === "settlement-write-refused" ? [body] : []);
    expect(fs.existsSync(runDir)).toBe(true);
    const held = store.readRunLedger().runs.find(row => row.requestId === requestId);
    if (seam === "competing-attempt" || seam === "settlement-write-refused") expect(held?.ownerTurn?.completionAttempt?.body).toEqual(body);
    else expect(held?.ownerTurn?.completionAttempt).toBeUndefined();
    if (seam === "competing-late-answer") expect(held?.ownerTurn?.lateAnswer?.body).toEqual(body);
    writer.mockRestore();
    if (seam === "write-refused") {
      await sweepExternalRelayOrphans();
      expect(posts).toEqual([expect.objectContaining({ outcome: "answered", answer: body.answer })]);
      expect(store.readRunLedger().runs.find(row => row.requestId === requestId)).toBeUndefined();
    } else if (seam === "competing-attempt" || seam === "settlement-write-refused") {
      clock.mockReturnValue(epoch + 61000);
      await sweepExternalRelayOrphans();
      expect(posts).toEqual(seam === "settlement-write-refused" ? [body] : []);
      expect(store.readRunLedger().runs.find(row => row.requestId === requestId)?.ownerTurn?.completionAttempt?.body).toEqual(body);
    } else if (seam === "competing-late-answer") {
      clock.mockReturnValue(epoch + 61000);
      await sweepExternalRelayOrphans();
      expect(routes).toEqual(["/api/relay/v1/targets/target_1/send"]);
      expect(posts).toEqual([expect.objectContaining({ text: body.answer.text })]);
      expect(store.readRunLedger().runs.find(row => row.requestId === requestId)).toBeUndefined();
    } else {
      await sweepExternalRelayOrphans();
      expect(posts).toEqual([{ lease_id: "fixture", outcome: "failed", reason: "install_restarted", detail: null }]);
    }
  } finally {
    writer.mockRestore(); clock.mockRestore(); store.dropRun(requestId); await service.close();
    await fs.promises.rm(runDir, { recursive: true, force: true });
  }
});

test("multipart late delivery resumes after restart with receipts and the unresolved part's key", async () => {
  const { readRunLedger, reserveRun, dropRun } = await import("./store");
  const relay = setupRelay();
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/multipart-process-`);
  const runDir = await fs.promises.mkdtemp(`${process.env.TMPDIR}/llv-external-relay-`);
  const text = "x".repeat(4095) + "😀<&>".repeat(1100);
  const body = { lease_id: "fixture", outcome: "answered" as const, duration_ms: 121000,
    answer: { action: "reply" as const, reply_to: "m1", text, format: "rich_markdown" as const } };
  const request = { request_id: "multipart_process" };
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const payloads: { client_key: string; text: string; parse_mode: unknown }[] = [];
  const visible = new Map<string, string>(), visits = new Map<string, number>();
  const service = await startTestRelay((req, raw) => {
    expect(req.url).toBe("/api/relay/v1/targets/target_1/send");
    const part = raw as typeof payloads[number]; payloads.push(part);
    const visit = (visits.get(part.client_key) ?? 0) + 1; visits.set(part.client_key, visit);
    if (visible.size === 1 && !visible.has(part.client_key)) {
      expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.lateAnswer?.parts?.[0]?.receipt?.kind).toBe("sent");
    }
    const isSecond = part.text.startsWith("😀");
    if (isSecond && visit === 2) return { status: 409, body: { error: { code: "unrecognised" } } };
    visible.set(part.client_key, part.text);
    if (isSecond && visit === 1) return { drop: true };
    return { body: cloneReceipt(100 + visible.size, visit > 1) };
  });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  reserveRun({ requestId: request.request_id, leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir,
    startedAt: new Date(epoch).toISOString(), capacityReleased: true,
    ownerTurn: { clientAttemptId: "relay-owner-multipart", delivery, lateAnswer: { body, files: [] } } }, 1);
  try {
    await deliveryProcess(directory, { relay, request, epoch, phase: "finish" });
    const saved = readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.lateAnswer;
    expect(saved?.parts?.[0]?.receipt?.kind).toBe("sent");
    expect(saved?.parts?.[1]?.receipt).toBeUndefined();
    expect(saved?.parts?.[1]?.firstAttemptAt).toBe(epoch);
    const secondKey = saved!.parts![1]!.payload.client_key;
    await deliveryProcess(directory, { relay, request, epoch: epoch + 31000, phase: "finish" });
    await deliveryProcess(directory, { relay, request, epoch: epoch + 62000, phase: "finish" });
    expect(payloads.filter(part => part.client_key === saved!.parts![0]!.payload.client_key)).toHaveLength(1);
    const retries = payloads.filter(part => part.client_key === secondKey);
    expect(retries).toHaveLength(3);
    for (const retry of retries) expect(retry).toEqual(saved!.parts![1]!.payload);
    expect([...visible.values()].join("")).toBe(text);
    for (const part of payloads) { expect(part.text.length).toBeLessThanOrEqual(4096); expect(part.parse_mode).toBeNull(); }
    expect(readRunLedger().runs.find(row => row.requestId === request.request_id)).toBeUndefined();
  } finally { dropRun(request.request_id); await service.close();
    await fs.promises.rm(directory, { recursive: true, force: true }); await fs.promises.rm(runDir, { recursive: true, force: true }); }
}, 60000);

test("permanent late-text refusal stays fenced after process restart", async () => {
  const { reserveRun, readRunLedger, dropRun } = await import("./store");
  const relay = setupRelay();
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/refusal-process-`);
  const epoch = Date.parse("2026-10-24T15:00:00Z");
  const request = { request_id: "permanent_process" };
  let calls = 0;
  const service = await startTestRelay(() => { calls++; return { status: 400, body: { error: { code: "text_too_long" } } }; });
  relay.origin = service.origin; relay.api_base = `${service.origin}/api/relay/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  reserveRun({ requestId: request.request_id, leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: "",
    startedAt: new Date(epoch).toISOString(), capacityReleased: true,
    ownerTurn: { clientAttemptId: "relay-owner-permanent", delivery, lateAnswer: { files: [], body: {
      lease_id: "fixture", outcome: "answered", duration_ms: 121000, answer: { action: "reply", text: "Retained answer", reply_to: "m1" } } } } }, 1);
  try {
    for (const offset of [0, 31000, 62000]) await deliveryProcess(directory, { relay, request, epoch: epoch + offset, phase: "finish" });
    expect(calls).toBe(1);
    expect(readRunLedger().runs.find(row => row.requestId === request.request_id)?.ownerTurn?.lateAnswer?.status).toBe("refused");
  } finally { dropRun(request.request_id); await service.close(); await fs.promises.rm(directory, { recursive: true, force: true }); }
}, 60000);

test("uncertain completion custody still confirms an interrupted host stop", async () => {
  const { reserveRun, readRunLedger, dropRun, runHoldsCapacity } = await import("./store");
  const { sweepExternalRelayOrphans } = await import("./poller");
  const relay = setupRelay();
  const requestId = "completion_stop_pending";
  reserveRun({ requestId, leaseId: "fixture", relayId: relay.id, targetId: "target_1",
    ownerPid: 2147483647, ownerIdentity: "gone", childPid: null, childIdentity: null, runDir: "",
    startedAt: "2026-10-24T15:00:00Z", conversationId: "conversation_completion_stop",
    ownerTurn: { clientAttemptId: "relay-owner-completion-stop", delivery, admissionComplete: true,
      completionAttempt: { files: [], body: { lease_id: "fixture", outcome: "answered", duration_ms: 121000,
        answer: { action: "reply", text: "Unconfirmed answer", reply_to: "m1" } } } } }, 1);
  const stops: string[] = [];
  const wire = spyOn(client, "relayCall").mockRejectedValue(new Error("unexpected delivery"));
  const ports = { launch: async () => { throw new Error("unexpected execution retry"); },
    observe: async () => ({ state: "ended" as const }), stop: async (id: string) => { stops.push(id); } };
  try {
    await sweepExternalRelayOrphans(ports);
    await sweepExternalRelayOrphans(ports);
    expect(stops).toEqual(["conversation_completion_stop"]);
    const row = readRunLedger().runs.find(row => row.requestId === requestId)!;
    expect(row.ownerTurn?.completionAttempt?.body).toMatchObject({ outcome: "answered" });
    expect(row.ownerTurn?.confirmed).toBe(true); expect(runHoldsCapacity(row)).toBe(false);
    expect(wire).not.toHaveBeenCalled();
  } finally { wire.mockRestore(); dropRun(requestId); }
});
