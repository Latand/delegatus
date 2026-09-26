import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import { beginDeputy, readDeputies } from "./deputies";
import { askOrchestratorInParallel, deputyMessageKey, deputySessionId, type DeputyCommandPorts } from "./deputyCommand";
import type { OrchestratorSeat } from "./seats";

/*
 * «Ask in parallel», slice 1 (docs/design/ghost-seat.md §5): the steps are
 * durable in order, a retry under the same clientRequestId resumes from the
 * record, and nothing forks, registers or delivers twice. The store is the real
 * one in a sandbox; every side effect past it is a port that records calls.
 */

const PROJECT = "proj-ghost";
const SEAT_ID = "conversation_seat";
const SEAT_PATH = "/fixture/projects/-repo/0a1b2c3d-4e5f-\x34a6b-8c7d-9e0f1a2b3c4d.jsonl";
let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deputy-command-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const seat: OrchestratorSeat = {
  project: PROJECT,
  seatEpoch: 4,
  conversationId: SEAT_ID,
  path: SEAT_PATH,
  mandate: "own the board",
  promptVersion: null,
  predecessorConversationId: null,
  state: "active",
  intent: { clientRequestId: "seed", mode: "spawn", launchId: null, error: null },
  designatedAt: "2026-09-26T09:00:00.000Z",
  activatedAt: "2026-09-26T09:00:00.000Z",
};

interface Calls {
  forks: { destination: string; sessionId: string; operationId: string }[];
  registered: { artifactPath: string; launchProfile: Record<string, unknown> }[];
  joined: string[];
  delivered: { clientMessageId: string; text: string }[];
  watched: number;
  order: string[];
}

function ports(overrides: Partial<DeputyCommandPorts> = {}, calls: Calls = { forks: [], registered: [], joined: [], delivered: [], watched: 0, order: [] }) {
  const value: DeputyCommandPorts = {
    now: () => new Date("2026-09-26T12:00:00.000Z"),
    activeSeat: () => seat,
    seatBusy: async () => true,
    seatGeneration: () => ({
      engine: "claude",
      path: SEAT_PATH,
      accountId: "account-a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "claude-opus-5-5", effort: "high", mcpServers: [], role: "root" }),
    }),
    fork: (input) => {
      calls.order.push(`fork:${readDeputies().length}`);
      calls.forks.push({ destination: input.destination, sessionId: input.sessionId, operationId: input.operationId });
      return { path: input.destination, records: 40 };
    },
    registerConversation: (input) => {
      calls.order.push("register");
      calls.registered.push({ artifactPath: input.artifactPath, launchProfile: input.launchProfile as Record<string, unknown> });
      return "conversation_ghost";
    },
    joinSeatTask: (input) => { calls.joined.push(input.deputyConversationId); },
    workContext: () => ({ openLanes: [{ id: "pipeline_1", title: "Seat's own lane", state: "running", stage: "build" }], recentTasks: [] }),
    deliver: async (input) => {
      calls.order.push("deliver");
      calls.delivered.push({ clientMessageId: input.clientMessageId, text: input.text });
      return { ok: true };
    },
    watch: () => { calls.watched += 1; },
    ...overrides,
  };
  return { ports: value, calls };
}

const ask = { project: PROJECT, text: "Add a task: reviewer for #2244", clientRequestId: "ask-1" };

test("refused while the seat is idle: the plain send is right then", async () => {
  const { ports: idle, calls } = ports({ seatBusy: async () => false });
  const result = await askOrchestratorInParallel(ask, idle);
  expect(result).toMatchObject({ ok: false, code: "seat_not_busy", status: 409 });
  expect(readDeputies()).toEqual([]);
  expect(calls.forks).toEqual([]);
});

test("refused while another deputy of the seat is live", async () => {
  beginDeputy({ project: PROJECT, seatConversationId: SEAT_ID, seatEpoch: 4, seatPath: SEAT_PATH, clientRequestId: "ask-0", ask: { text: "earlier", images: 0, sender: null }, now: new Date("2026-09-26T11:58:00.000Z") });
  const { ports: busy, calls } = ports();
  const result = await askOrchestratorInParallel(ask, busy);
  expect(result).toMatchObject({ ok: false, code: "deputy_limit", status: 409 });
  expect(calls.forks).toEqual([]);
});

test("a Codex seat is refused in slice 1", async () => {
  const { ports: codex } = ports({ seatGeneration: () => ({ engine: "codex", path: SEAT_PATH, accountId: null, launchProfile: emptyLaunchProfile() }) });
  expect(await askOrchestratorInParallel(ask, codex)).toMatchObject({ ok: false, code: "seat_not_claude" });
});

test("the record is written before the fork, and the fork runs under the seat's profile beside the seat", async () => {
  const { ports: busy, calls } = ports();
  const result = await askOrchestratorInParallel(ask, busy);
  expect(result.ok).toBe(true);
  /* The record existed when the fork ran. */
  expect(calls.order).toEqual(["fork:1", "register", "deliver"]);
  const record = readDeputies()[0]!;
  expect(record).toMatchObject({
    state: "active",
    seatConversationId: SEAT_ID,
    seatEpoch: 4,
    deputyConversationId: "conversation_ghost",
    forkRecordCount: 40,
    ask: { text: "Add a task: reviewer for #2244", images: 0, sender: null },
    expiresAt: "2026-09-26T12:15:00.000Z",
  });
  expect(calls.forks[0]!.destination).toBe(path.join(path.dirname(SEAT_PATH), `${deputySessionId(record.askId)}.jsonl`));
  expect(calls.registered[0]!.launchProfile).toMatchObject({ model: "claude-opus-5-5", effort: "high", parentConversationId: SEAT_ID, role: "root" });
  expect(calls.joined).toEqual(["conversation_ghost"]);
  /* One message: the ask, then the note naming the main self and its lanes. */
  expect(calls.delivered).toHaveLength(1);
  expect(calls.delivered[0]!.clientMessageId).toBe(deputyMessageKey(record.askId));
  expect(calls.delivered[0]!.text).toStartWith("Add a task: reviewer for #2244\n");
  expect(calls.delivered[0]!.text).toContain(`conversation ${SEAT_ID}`);
  expect(calls.delivered[0]!.text).toContain("lane pipeline_1");
  expect(calls.watched).toBe(1);
});

test("a crash between the record and the launch replays on the same key without a second fork or host", async () => {
  /* First attempt: the delivery never answers (the process died there). */
  const first = ports({ deliver: async () => { throw new Error("process died"); } });
  await expect(askOrchestratorInParallel(ask, first.ports)).rejects.toThrow("process died");
  expect(first.calls.forks).toHaveLength(1);
  expect(readDeputies()[0]).toMatchObject({ state: "pending", deputyConversationId: "conversation_ghost", forkRecordCount: 40 });

  /* The retry: the seat is idle by now, and the busy check does not apply. */
  const retry = ports({ seatBusy: async () => false });
  const result = await askOrchestratorInParallel(ask, retry.ports);
  expect(result).toMatchObject({ ok: true, replayed: true, deputyConversationId: "conversation_ghost" });
  expect(retry.calls.forks).toEqual([]);
  expect(retry.calls.registered).toEqual([]);
  expect(retry.calls.delivered).toHaveLength(1);
  expect(retry.calls.delivered[0]!.clientMessageId).toBe(deputyMessageKey(readDeputies()[0]!.askId));

  /* A third call after activation delivers nothing more. */
  const again = ports();
  expect(await askOrchestratorInParallel(ask, again.ports)).toMatchObject({ ok: true, replayed: true });
  expect(again.calls.delivered).toEqual([]);
  expect(readDeputies()).toHaveLength(1);
});

test("a fork that fails ends the record, so the seat is free for the next ask", async () => {
  const { ports: failing } = ports({ fork: () => { throw new Error("history-too-large"); } });
  const result = await askOrchestratorInParallel(ask, failing);
  expect(result).toMatchObject({ ok: false, code: "fork_failed" });
  expect(readDeputies()[0]).toMatchObject({ state: "ended", outcome: "failed" });
  const next = ports();
  expect((await askOrchestratorInParallel({ ...ask, clientRequestId: "ask-2" }, next.ports)).ok).toBe(true);
});
