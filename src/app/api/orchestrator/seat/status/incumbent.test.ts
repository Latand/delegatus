import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";

import { ROTATION_NOTE, readOrchestratorIncumbent, productionIncumbentDependencies, type IncumbentReadDependencies } from "./incumbent";
import { GET } from "./route";

/*
 * The incumbent read (PRD #976 slice B): the panel header's engine/model/account
 * and context %, and the rotation recommendation that until now existed only
 * inside `get_orchestrator`.
 *
 * Everything here runs against an ISOLATED state directory — this suite must
 * never touch the operator's live seats.
 */

/* Everything the route and the seat store resolve their paths from, pointed at
   one throwaway directory: the operator's own agent-log-viewer state, claude
   home and codex home are never opened by this file. */
const ISOLATED = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "HOME", "TMPDIR", "LLV_CLAUDE_HOME", "LLV_CODEX_HOME"] as const;

let sandbox = "";
let previous: Partial<Record<(typeof ISOLATED)[number], string | undefined>> = {};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orch-incumbent-"));
  previous = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
  for (const name of ISOLATED) process.env[name] = sandbox;
});

afterEach(() => {
  for (const name of ISOLATED) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const AT = "2026-08-13T10:00:00.000Z";

/** An active seat for `proj-a`, whose transcript is `bytes` long and — when a
    count is given — ends on a provider-reported usage row the reading prefers. */
function seatWithTranscript(bytes: number, reportedTokens?: number): string {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  const usage = reportedTokens === undefined
    ? ""
    : JSON.stringify({ type: "assistant", message: { usage: { input_tokens: reportedTokens, output_tokens: 12 } } }) + "\n";
  const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) + "\n";
  fs.writeFileSync(transcript, filler.repeat(Math.max(1, Math.round((bytes - usage.length) / filler.length))) + usage, "utf8");
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "run the board", clientRequestId: "req_00000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_00000001", conversationId: "conversation_a", path: transcript, now: AT });
  return transcript;
}

function conversation(transcript: string, overrides: { model?: string | null; effort?: string | null; accountId?: string | null } = {}): RegistryConversation {
  return {
    engine: "claude",
    generations: [{
      path: transcript,
      accountId: overrides.accountId === undefined ? "work" : overrides.accountId,
      launchProfile: { model: overrides.model === undefined ? "opus" : overrides.model, effort: overrides.effort ?? null, cwd: "/repos/atlas" },
    }],
  } as unknown as RegistryConversation;
}

function dependencies(overrides: Partial<IncumbentReadDependencies> = {}): IncumbentReadDependencies {
  return {
    conversation: () => null,
    /* No host anywhere: the liveness plane knows nothing about this one. */
    liveness: async () => null,
    sessionCounts: () => null,
    ...overrides,
  };
}

test("a vacant project reports no incumbent at all — never a stale memory of the last one", async () => {
  const body = await readOrchestratorIncumbent("proj-a", dependencies());
  expect(body).toMatchObject({ designated: false, conversationId: null, engine: null, model: null, context: null, rotation: null });
});

test("the incumbent's engine, model, account and context percent are what the header shows", async () => {
  const transcript = seatWithTranscript(4_096, 250_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: (id: ViewerConversationId) => (id === "conversation_a" ? conversation(transcript, { accountId: "work" }) : null),
  }));

  expect(body.designated).toBe(true);
  expect(body.engine).toBe("claude");
  expect(body.model).toBe("opus");
  expect(body.accountId).toBe("work");
  expect(body.cwd).toBe("/repos/atlas");
  /* Provider-reported usage against the opus window policy: 250k of 1M. */
  expect(body.context).toMatchObject({ tokens: 250_000, limit: 1_000_000, percent: 25, estimated: false });
  expect(body.rotation?.recommended).toBe(false);
});

test("reaching the configured threshold RECOMMENDS and says so — and the payload carries no action", async () => {
  const transcript = seatWithTranscript(4_096, 620_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
  }));

  expect(body.context?.percent).toBe(62);
  expect(body.rotation).toMatchObject({ recommended: true, level: "strongly_recommend", advisory: "STRONGLY_RECOMMEND_ROTATION" });
  expect(body.rotation?.reasons[0]).toContain("rotation threshold");
  expect(body.rotation?.threshold).toMatchObject({ windowTokens: 1_000_000, thresholdTokens: 500_000, policy: "claude-opus-1m" });
  /* WORDS ONLY: the whole payload is data, and it says so in its own note. */
  expect(body.rotation?.note).toBe(ROTATION_NOTE);
  expect(JSON.stringify(body)).not.toContain("rotate_orchestrator\":");
});

/** Invented base64: `bytes` of a repeating pattern, encoded — no real image. */
function inventedBase64(bytes: number, seed: number): string {
  return Buffer.from(Array.from({ length: bytes }, (_, index) => (index * 31 + seed) % 256)).toString("base64");
}

test("a first oversized image message with no usage is unconfirmed; provider usage replaces it", async () => {
  /* The shape read on this machine: a Claude seat's first operator message is
     one user row whose content is 13 `{type:"image",source:{type:"base64"}}`
     blocks (84–618 KB of base64 each, 4.4 MB in the row) plus the text, and
     the reply's assistant rows carry message.usage once they are written. */
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  const images = Array.from({ length: 13 }, (_, index) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: inventedBase64(240 * 1024, index) },
  }));
  const firstMessage = { type: "user", message: { role: "user", content: [...images, { type: "text", text: "what is on these screens?" }] } };
  fs.writeFileSync(transcript, JSON.stringify(firstMessage) + "\n", "utf8");
  expect(fs.statSync(transcript).size).toBeGreaterThan(4 * 1024 * 1024);
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "run the board", clientRequestId: "req_00000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_00000001", conversationId: "conversation_a", path: transcript, now: AT });
  const read = () => readOrchestratorIncumbent("proj-a", dependencies({ conversation: () => conversation(transcript) }));

  const running = await read();
  expect(running.context).toMatchObject({ estimated: true, limit: 1_000_000 });
  expect(running.context!.tokens).toBeNull();
  expect(running.context!.percent).toBeNull();
  expect(running.context!.basis).toContain("UNCONFIRMED");
  expect(running.rotation).toMatchObject({ recommended: false, level: "none", advisory: null, reasons: [] });

  fs.appendFileSync(
    transcript,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I see" }], usage: { input_tokens: 2, cache_creation_input_tokens: 31_000, cache_read_input_tokens: 9_000, output_tokens: 40 } } }) + "\n",
    "utf8",
  );
  const answered = await read();
  expect(answered.context).toMatchObject({ tokens: 40_002, percent: 4, estimated: false });
  expect(answered.rotation).toMatchObject({ recommended: false, level: "none" });
});

test("a model with no window policy states the usage it can prove and calls the threshold unknown", async () => {
  const transcript = seatWithTranscript(2_048, 90_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => ({ ...conversation(transcript), engine: "codex" }) as RegistryConversation,
  }));

  expect(body.context).toMatchObject({ tokens: 90_000, limit: null, percent: null });
  expect(body.rotation).toMatchObject({ recommended: false, thresholdUnknown: true, threshold: null });
});

test("compactions recorded in the transcript remain informational", async () => {
  const transcript = seatWithTranscript(2_048, 10_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
    sessionCounts: () => ({ messages: 400, tools: 900, compactions: 3 }),
  }));

  expect(body.transcriptFacts).toMatchObject({ messageCount: 400, toolCount: 900, compactionCount: 3 });
  expect(body.rotation).toMatchObject({ recommended: false, level: "none" });
  expect(body.rotation?.reasons).toEqual([]);
});

test("an unsettled registry generation reads as unknown rather than inventing a model to judge by", async () => {
  seatWithTranscript(2_048, 900_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({ conversation: () => null }));

  expect(body.designated).toBe(true);
  expect(body.engine).toBeNull();
  expect(body.model).toBeNull();
  /* No engine, so no window policy, so no threshold is claimed either way. */
  expect(body.context?.limit).toBeNull();
  expect(body.rotation?.level).toBe("none");
});

test("a liveness plane that throws says nothing — it never invents a dead host as a rotation reason", async () => {
  const transcript = seatWithTranscript(2_048, 10_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
    liveness: async () => {
      throw new Error("the liveness plane is unavailable");
    },
  }));

  expect(body.liveness).toBeNull();
  expect(body.rotation).toMatchObject({ recommended: false, level: "none" });
});

test("a host the liveness plane reports GONE is a recommendation reason, and the health it reports rides along", async () => {
  const transcript = seatWithTranscript(2_048, 10_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
    liveness: async () => ({ lifecycle: "gone", hostState: "absent", silentForMs: 900_000 }),
  }));

  expect(body.liveness).toMatchObject({ lifecycle: "gone", hostState: "absent", silentForMs: 900_000 });
  expect(body.rotation).toMatchObject({ recommended: true, level: "recommend" });
  expect(body.rotation?.reasons.join(" ")).toContain("host is gone");
});

test("the route answers the read, and refuses a request that names no project", async () => {
  seatWithTranscript(1_024);
  const missing = await GET(new NextRequest("http://127.0.0.1/api/orchestrator/seat/status"));
  expect(missing.status).toBe(400);

  const answer = await GET(new NextRequest("http://127.0.0.1/api/orchestrator/seat/status?project=proj-a"));
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ project: "proj-a", designated: true, conversationId: "conversation_a" });
});

test("a seat that holds Telegram reports what the operator has to do; a seat without it reports nothing", async () => {
  const transcript = seatWithTranscript(4_096);
  const withGrant = (mcpServers: string[]) => {
    const record = conversation(transcript);
    (record.generations[0]!.launchProfile as { mcpServers: string[] }).mcpServers = mcpServers;
    return record;
  };
  for (const action of ["sign_in", "check", null] as const) {
    const body = await readOrchestratorIncumbent("proj-a", dependencies({
      conversation: () => withGrant(["viewer", "telegram"]),
      telegramAction: () => action,
    }));
    expect(body.telegram).toBe(action);
  }
  /* No grant: Telegram's state is not this seat's business. */
  const ungranted = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => withGrant(["viewer"]),
    telegramAction: () => "sign_in",
  }));
  expect(ungranted.telegram).toBeNull();
  const vacant = await readOrchestratorIncumbent("proj-b", dependencies({ telegramAction: () => "sign_in" }));
  expect(vacant.telegram).toBeNull();
});

test("status reads native counts, fresh capacity and boundaries without changing the seat", async () => {
  const transcript = seatWithTranscript(9 * 1024 * 1024, 980_000);
  const snapshot = JSON.stringify((await import("@/lib/orchestrator/seats")).orchestratorSeatFor("proj-a"));
  const read = () => readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript, { model: "opus[1m]" }),
    sessionCounts: productionIncumbentDependencies.sessionCounts,
  }));
  fs.appendFileSync(transcript, [
    { type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 1_249 } },
    { type: "system", subtype: "compact_boundary" },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const stale = await read();
  expect(stale.transcriptFacts?.compactionCount).toBe(2);
  expect(stale.context).toMatchObject({ tokens: null, estimated: true });
  expect(stale.rotation).toMatchObject({ recommended: false, level: "none", causes: [] });
  for (const capacity of [200_000, 1_000_000]) for (const percent of [49, 50, 51]) {
    fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { context_window: capacity, usage: { input_tokens: capacity * percent / 100 } } }) + "\n");
    const fresh = await read();
    expect(fresh.context).toMatchObject({ tokens: capacity * percent / 100, limit: capacity, percent, estimated: false });
    expect(fresh.rotation?.level).toBe(percent < 50 ? "none" : "strongly_recommend");
    expect(fresh.transcriptFacts?.compactionCount).toBe(2);
  }
  expect(JSON.stringify((await import("@/lib/orchestrator/seats")).orchestratorSeatFor("proj-a"))).toBe(snapshot);
});

test("status shows two Codex native boundaries without inventing a rotation threshold", async () => {
  const transcript = seatWithTranscript(2_048);
  fs.appendFileSync(transcript, [
    { type: "response_item", payload: { type: "ContextCompaction", id: "a" } },
    { type: "response_item", payload: { type: "ContextCompaction", id: "b" } },
    { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 200_000, last_token_usage: { input_tokens: 150_000 } } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => ({ ...conversation(transcript, { model: "gpt-6.1-sol" }), engine: "codex" }) as RegistryConversation,
    sessionCounts: productionIncumbentDependencies.sessionCounts,
  }));
  expect(body.transcriptFacts?.compactionCount).toBe(2);
  expect(body.context).toMatchObject({ tokens: 150_000, limit: 200_000, percent: 75, estimated: false });
  expect(body.rotation).toMatchObject({ recommended: false, threshold: null, thresholdUnknown: true });
});
