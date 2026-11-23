import { expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import { statePath } from "@/lib/configDir";
import { TurnSilence, TURN_SILENCE_MS, turnSilenceProgress } from "./turnSilence";
import type { HostState, RuntimeEvent } from "./engineHost";

function fixture(session: string) {
  let now = Date.parse("2026-11-01T00:00:00Z");
  let scheduled: (() => Promise<void>) | undefined;
  let current = true;
  const expired: string[] = [], holds: string[] = [];
  const state = { sessionKey: session, activeTurnRef: "turn", status: "active", pendingAttention: [] } as unknown as HostState;
  const watchdog = new TurnSilence({ engine: "fixture", artifactPath: () => null, state: () => state, current: () => current,
    expire: turn => expired.push(turn), hold: (_turn, reason) => holds.push(reason) }, {
    now: () => now, schedule: callback => { scheduled = callback; return () => { if (scheduled === callback) scheduled = undefined; }; },
  });
  const emit = (event: Omit<Extract<RuntimeEvent, { kind: "item" }>, "seq">) => watchdog.observe(event);
  return { watchdog, state, expired, holds, emit, start: () => watchdog.observe({ kind: "turn-started", turnId: "turn" }),
    advance: (ms: number) => { now += ms; }, expire: async () => { expect(scheduled).toBeFunction(); await scheduled!(); }, revoke: () => { current = false; } };
}

test.each(["commandExecution", "mcpToolCall", "webSearch", "imageGeneration", "tool_call", "tool_call_update"])("%s remains owned until its matching result", async type => {
  const f = fixture(`tool-${type}`); f.start();
  f.emit({ kind: "item", turnId: "turn", phase: "started", item: { type, id: "tool", toolCallId: "tool" } });
  f.advance(TURN_SILENCE_MS * 2); await f.expire(); expect(f.expired).toEqual([]); expect(f.holds).toHaveLength(1);
  f.emit({ kind: "item", turnId: "turn", phase: "completed", item: { type, id: "tool", toolCallId: "tool" } });
  f.advance(TURN_SILENCE_MS - 1); await f.expire(); expect(f.expired).toEqual([]);
  f.advance(1); await f.expire(); expect(f.expired).toEqual(["turn"]);
});

test("echoes, heartbeats, unrelated turns and synthetic provider envelopes do not refresh silence", async () => {
  const f = fixture("echoes"); f.start(); f.advance(TURN_SILENCE_MS);
  for (const item of [{ type: "user", message: { content: "wake" } }, { type: "system", subtype: "heartbeat" },
    { type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { content: [{ type: "text", text: "capacity unavailable" }] } }])
    f.emit({ kind: "item", turnId: "turn", phase: "completed", item });
  f.watchdog.observe({ kind: "delta", turnId: "other", text: "unrelated" });
  await f.expire(); expect(f.expired).toEqual(["turn"]);
});

test("durable deadline survives a new watchdog owner and a lost fence prevents termination", async () => {
  const session = "silence-restart";
  const first = fixture(session); first.start(); first.watchdog.stop();
  const next = fixture(session); next.advance(TURN_SILENCE_MS + 30_000); next.start(); await next.expire();
  expect(next.expired).toEqual(["turn"]);
  const revoked = fixture("revoked"); revoked.start(); revoked.advance(TURN_SILENCE_MS); revoked.revoke(); await revoked.expire();
  expect(revoked.expired).toEqual([]);
});

test("provider retry expiry and attention resolution return the turn to bounded eligibility", async () => {
  const f = fixture("provider-retry"); f.start(); f.state.pendingAttention = ["question"];
  const activity = turnSilenceProgress("fixture", "provider-retry", "turn");
  f.advance(TURN_SILENCE_MS); await f.expire(); expect(f.expired).toEqual([]);
  expect(turnSilenceProgress("fixture", "provider-retry", "turn")).toBe(activity);
  f.state.pendingAttention = []; f.state.providerRetry = { at: "2026-11-01T00:15:00Z", retryAt: "2026-11-01T00:30:00Z", status: 503, error: null };
  f.advance(60_000); await f.expire(); expect(f.expired).toEqual([]);
  f.advance(14 * 60_000); await f.expire(); expect(f.expired).toEqual([]);
  f.advance(TURN_SILENCE_MS); await f.expire(); expect(f.expired).toEqual(["turn"]);
});


test("two real processes retain the same eligible silence deadline", async () => {
  for (const elapsed of [0, TURN_SILENCE_MS + 30_000]) {
    const code = `
      import { TurnSilence } from ${JSON.stringify(import.meta.dir + "/turnSilence.ts")};
      let ended = 0;
      const state = { sessionKey: "process-restart", activeTurnRef: "turn", status: "active", pendingAttention: [] };
      const watchdog = new TurnSilence({ engine: "fixture", artifactPath: () => null, state: () => state,
        current: () => true, expire: () => ended++, hold: () => {} }, {
        now: () => Date.parse("2026-11-01T00:00:00Z") + ${elapsed}, schedule: () => () => {},
      });
      watchdog.observe({ kind: "turn-started", turnId: "turn" });
      await watchdog.check();
      if (ended !== ${elapsed === 0 ? 0 : 1}) throw new Error("durable silence deadline was renewed");
      watchdog.stop();`;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  }
});


test("heartbeats after repeated adoption cannot accumulate checkpoint allowance", async () => {
  const session = "repeated-adoption";
  const first = fixture(session); first.start(); first.watchdog.stop();
  const middle = fixture(session); middle.advance(60_000); middle.start(); middle.advance(30_000);
  middle.emit({ kind: "item", turnId: "turn", phase: "completed", item: { type: "system", subtype: "heartbeat" } });
  middle.watchdog.stop();
  const last = fixture(session); last.advance(TURN_SILENCE_MS + 30_000); last.start(); await last.expire();
  expect(last.expired).toEqual(["turn"]);
});


test("unreadable checkpoint retains the cause and ownership without overwriting evidence", async () => {
  const session = "invalid-checkpoint";
  const file = statePath("turn-silence", crypto.createHash("sha256").update(`fixture:${session}`).digest("hex") + ".json");
  fs.mkdirSync(statePath("turn-silence"), { recursive: true }); fs.writeFileSync(file, "invalid checkpoint");
  const f = fixture(session); f.start(); f.advance(TURN_SILENCE_MS); await f.expire();
  expect(f.expired).toEqual([]); expect(f.holds[0]).toContain("checkpoint unavailable");
  expect(fs.readFileSync(file, "utf8")).toBe("invalid checkpoint"); f.watchdog.stop();
});


test("a heartbeat cannot postpone checkpointing new model progress before adoption", async () => {
  const session = "progress-after-heartbeat";
  const first = fixture(session); first.start(); first.advance(30_000);
  first.emit({ kind: "item", turnId: "turn", phase: "completed", item: { type: "system", subtype: "heartbeat" } });
  first.advance(29_000); first.watchdog.observe({ kind: "delta", turnId: "turn", text: "model output" }); first.watchdog.stop();
  const restored = fixture(session); restored.advance(TURN_SILENCE_MS + 31_000); restored.start(); await restored.expire();
  expect(restored.expired).toEqual([]); restored.watchdog.stop();
});


test("new output immediately after adoption replaces an older durable deadline", async () => {
  const session = "progress-after-adoption";
  const first = fixture(session); first.start(); first.watchdog.stop();
  const middle = fixture(session); middle.advance(600_000); middle.start(); middle.advance(5_000);
  middle.watchdog.observe({ kind: "delta", turnId: "turn", text: "resumed output" }); middle.watchdog.stop();
  const last = fixture(session); last.advance(TURN_SILENCE_MS + 31_000); last.start(); await last.expire();
  expect(last.expired).toEqual([]); last.watchdog.stop();
});


test("a retired writer cannot update the checkpoint with late output or a new turn", () => {
  const session = "retired-writer";
  const file = statePath("turn-silence", crypto.createHash("sha256").update(`fixture:${session}`).digest("hex") + ".json");
  const f = fixture(session); f.start();
  const saved = fs.readFileSync(file, "utf8");
  f.advance(60_000); f.revoke();
  f.watchdog.observe({ kind: "delta", turnId: "turn", text: "late output" });
  f.watchdog.observe({ kind: "turn-started", turnId: "replacement" });
  expect(fs.readFileSync(file, "utf8")).toBe(saved);
  expect(f.expired).toEqual([]); f.watchdog.stop();
});


test("attention resolution persists fresh eligibility across adoption without inventing model activity", async () => {
  const session = "attention-adoption";
  const first = fixture(session); first.start(); first.advance(600_000);
  first.watchdog.observe({ kind: "attention-resolved", id: "permission", resolution: "answered" });
  expect(turnSilenceProgress("fixture", session, "turn")).toBe(Date.parse("2026-11-01T00:00:00Z"));
  first.watchdog.stop();
  const adopted = fixture(session); adopted.advance(TURN_SILENCE_MS + 31_000); adopted.start(); await adopted.expire();
  expect(adopted.expired).toEqual([]); adopted.watchdog.stop();
});


test("three real processes retain a protected wait and grant fresh eligibility only once", async () => {
  for (const phase of ["hold", "recover", "expire"]) {
    const code = `
      import { TurnSilence, turnSilenceProgress } from ${JSON.stringify(import.meta.dir + "/turnSilence.ts")};
      const phase = ${JSON.stringify(phase)}, base = Date.parse("2026-11-01T00:00:00Z");
      let now = base + (phase === "expire" ? 2 * ${TURN_SILENCE_MS} + 60_000 : phase === "recover" ? ${TURN_SILENCE_MS} + 30_000 : 0), ended = 0, scheduledDelay = -1;
      const state = { sessionKey: "process-wait-restart", activeTurnRef: "turn", status: "active", pendingAttention: phase === "hold" ? ["permission"] : [] };
      const watchdog = new TurnSilence({ engine: "fixture", artifactPath: () => null, state: () => state,
        current: () => true, expire: () => ended++, hold: () => {} }, { now: () => now, schedule: (_callback, delay) => { scheduledDelay = delay; return () => {}; } });
      watchdog.observe({ kind: "turn-started", turnId: "turn" });
      if (phase === "recover" && scheduledDelay !== 0) throw new Error("restored wait verification was postponed");
      if (phase === "hold") now += ${TURN_SILENCE_MS};
      await watchdog.check();
      if (ended !== (phase === "expire" ? 1 : 0)) throw new Error("protected wait eligibility was lost or renewed");
      if (turnSilenceProgress("fixture", "process-wait-restart", "turn") !== base) throw new Error("wait was reported as model activity");
      watchdog.stop();`;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  }
});
