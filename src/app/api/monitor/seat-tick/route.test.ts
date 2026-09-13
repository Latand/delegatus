import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-route-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_SEAT_TICK_AUDIT_FILE: process.env.LLV_SEAT_TICK_AUDIT_FILE, LLV_RUNTIME_HOST_SOCKET: process.env.LLV_RUNTIME_HOST_SOCKET };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
process.env.LLV_SEAT_TICK_AUDIT_FILE = path.join(SANDBOX, "journal", "runs.ndjson");
/* A Viewer-spawned session inherits the live runtime host's socket; the
   diagnostics must ask nothing outside this process. */
delete process.env.LLV_RUNTIME_HOST_SOCKET;
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const { GET } = await import("./route");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { appendSeatTickRecord } = await import("@/lib/monitor/journalStore");
const { writeSeatTickState } = await import("@/lib/monitor/seatTickState");
const { emptySeatTickState } = await import("@/lib/monitor/types");
const { SEND_UNRECORDED_REASON } = await import("@/lib/runtime/sendSettlement");
import type { SeatTickDiagnostics } from "@/lib/monitor/seatTickDiagnostics";
import type { SeatTickOutstandingWake, SeatTickRunRecord } from "@/lib/monitor/types";

const PROJECT = "viewer";
const OTHER = "other-project";

afterEach(() => setAgentRegistryForTests(null));
afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function get(query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898/api/monitor/seat-tick${query}`, { headers: { host: "127.0.0.1" } });
}

function line(project: string, at: string, verdict: SeatTickRunRecord["verdict"], outcome: string | null): SeatTickRunRecord {
  return { schemaVersion: 1, at, project, seatEpoch: 7, verdict, reasons: [], items: 0, deferred: 0, eventsThrough: 3, delivery: outcome ? { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", outcome } : null, detail: null };
}

test("the project is required", async () => {
  const response = await GET(get(""));
  expect(response.status).toBe(400);
});

test("a fenced attempt is described whole — record, journal answer and exits — without ending the send or leaking the payload", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  const seat = registry.ensureConversation("claude", path.join(SANDBOX, "seat.jsonl"), null);
  /* A send the transport lost: reserved, claimed, never answered — resting
     in flight past its deadline, which only a check may end. */
  const key = "seat-tick:viewer:7:first:child-terminal:fp-1";
  const held = registry.holdDelivery(seat.id, "WAKE-PAYLOAD-SENTINEL", key, "text", [], null, { kind: "send", policy: "interrupt-active" } as never);
  expect(registry.beginDeliveryAttempt(held.id, held.generationId!)).not.toBeNull();
  const wake: SeatTickOutstandingWake = {
    clientMessageId: key,
    conversationId: seat.id,
    seatEpoch: 7,
    operationId: null,
    commit: { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-1", eventsThrough: 3, children: ["child-a"] },
    text: "WAKE-PAYLOAD-SENTINEL",
    preparedAt: "2026-09-11T15:44:11.502Z",
    dispatch: { token: "token-1", state: "refused" },
  };
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: "2026-09-10T05:33:29.256Z", eventsThrough: 3, outstandingWake: wake });
  appendSeatTickRecord(line(OTHER, "2026-09-13T16:00:00.000Z", "quiet", null));
  appendSeatTickRecord(line(PROJECT, "2026-09-13T16:04:00.000Z", "uncertain", "uncertain"));
  appendSeatTickRecord(line(PROJECT, "2026-09-13T16:04:01.000Z", "wake", "deferred-outstanding"));

  const response = await GET(get(`?project=${PROJECT}&limit=5`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as SeatTickDiagnostics;
  expect(body.project).toBe(PROJECT);
  expect(body.state).toMatchObject({ seatEpoch: 7, lastWakeAt: "2026-09-10T05:33:29.256Z", eventsThrough: 3 });
  expect(body.settings).toMatchObject({ enabled: true, isDefault: true, monitorPromptLength: 0 });
  expect(body.attempts).toHaveLength(1);
  const attempt = body.attempts[0]!;
  expect(attempt).toMatchObject({
    slot: "outstanding",
    clientMessageId: key,
    operationId: null,
    preparedAt: "2026-09-11T15:44:11.502Z",
    dispatch: { state: "refused" },
    textLength: "WAKE-PAYLOAD-SENTINEL".length,
    commit: { reasons: ["child-terminal"], children: 1 },
    withholds: true,
    /* In flight, reported as it rests: the record's own operation named, the
       journal not asked, nothing ended. */
    observation: { state: "retained", evidence: { operationId: held.command.operationId, record: { state: "in-flight" }, journal: "unasked" } },
  });
  expect(JSON.stringify(body)).not.toContain("WAKE-PAYLOAD-SENTINEL");
  expect(attempt.exits.some((exit) => exit.includes("superseded by a different conversation"))).toBe(true);
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries).find((row) => row.id === held.id)!.state).toBe("delivery-uncertain");
  /* The journal is this project's alone, newest last, bounded. */
  expect(body.journal.map((record) => [record.project, record.verdict])).toEqual([[PROJECT, "uncertain"], [PROJECT, "wake"]]);

  /* The same attempt once the settlement has ended it unrecorded: the record
     is failed and unverified, the journal cannot be asked here (no runtime
     host socket in this sandbox), and the fence stands. */
  registry.recordDeliveryOutcome(held.id, "failed", SEND_UNRECORDED_REASON, "unverified");
  const ended = await (await GET(get(`?project=${PROJECT}`))).json() as SeatTickDiagnostics;
  expect(ended.attempts[0]!.observation).toMatchObject({ state: "uncertain", evidence: { record: { state: "failed", resend: "verify-first" }, journal: "unreachable" } });
  expect(ended.attempts[0]!.exits.at(-1)).toBe("age alone ends nothing");
});

test("a project nobody has ticked reads as empty rather than failing", async () => {
  const body = await (await GET(get("?project=never-ticked"))).json() as SeatTickDiagnostics;
  expect(body).toMatchObject({ project: "never-ticked", seat: null, attempts: [], journal: [] });
  expect(body.state.seatEpoch).toBeNull();
});
