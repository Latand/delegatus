import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { createHash } from "node:crypto";
import http from "node:http";
import { callBody, toolSleep, type ToolLoopRuntime } from "./toolLoop";
import { requestSchema, handoffAnswerSchema, answerSchema, replyAnswerSchema, type ToolCallResult } from "./protocol";
import { x1Request, x1Results, x1Errors, x1Dir } from "./toolLoop.fixture";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import { processMatches, terminateHeadlessReviewerGroup } from "@/lib/agent/headless";
import type { AccountContext } from "@/lib/accounts/contracts";
import { createManagedClaudeAccount } from "@/lib/accounts/claude";
import { advertisedSlots, HANDOFF_DETAIL, memberLimitDetail, runClaimedRequest, runningCount } from "./runner";
import { relayActivity } from "./activity";
import { dropRun, externalRelayFile, readRunLedger, updateRelayStore, type PairedRelay } from "./store";
import { confirmRelayPairing } from "./pairing";
import { contextRequest, sampleRequest, serviceClaims } from "./request.fixture";
import { countMemberAnswers, listAnswerRecords, readAnswerRecord, settleInterruptedAnswer } from "./answers";
import { startTestRelay } from "./testRelay";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runner-test-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const original = accountManager.resolveHeadlessSpawn;
const home = path.join(root, "account");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "auth.json"), "{}");
fs.writeFileSync(
  path.join(home, "models_cache.json"),
  JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }),
);
const account: AccountContext = {
  engine: "codex",
  accountId: "answer",
  kind: "managed",
  home,
  transcriptRoot: home,
  env: { ...process.env },
};
accountManager.resolveHeadlessSpawn = (() => ({
  kind: "available",
  account,
})) as typeof original;
afterAll(() => {
  accountManager.resolveHeadlessSpawn = original;
});
function relay(api_base: string): PairedRelay {
  return {
    id: "relay_1",
    origin: api_base.replace(/\/v1$/, ""),
    api_base,
    name: "Test",
    description: "Test",
    credential: "x".repeat(43),
    owner: {
      namespace: "test",
      id: "owner",
      display_name: "Owner",
      handle: null,
    },
    pairedAt: new Date().toISOString(),
    paused: false,
    limits: {
      max_response_bytes: 1048576,
      max_wait_s: 25,
      max_answer_chars: 4000,
    },
    targets: [
      {
        id: "target_1",
        name: "Target",
        answered_by: "install",
        fallback: "service",
        enabled: true,
        engine: "codex",
        model: "gpt-6-sol",
        effort: "low",
        project: null,
        concurrency: 1,
        hardCapMinutes: 1,
      },
    ],
  };
}
function stub(script: string) {
  const file = path.join(root, `stub-${crypto.randomUUID()}`);
  fs.writeFileSync(file, `#!/usr/bin/env bun\n${script}\n`);
  fs.chmodSync(file, 0o700);
  return file;
}
test("an unsafe provider home declines as a profile error before launch", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const previous = accountManager.resolveHeadlessSpawn;
  const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
  try {
    process.env.LLV_CLAUDE_HOME = path.join(root, "empty-claude-home");
    fs.mkdirSync(process.env.LLV_CLAUDE_HOME, { recursive: true });
    const provider = createManagedClaudeAccount("Relay provider", {
      config: { baseUrl: "https://provider.invalid", model: "provider-model", smallFastModel: null },
      token: "local-provider-fixture-token",
    });
    fs.rmSync(path.join(provider.home, ".provider-token"));
    const unsafeAccount: AccountContext = {
      ...account,
      engine: "claude",
      home: provider.home,
    };
    accountManager.resolveHeadlessSpawn = (() => ({
      kind: "available", account: unsafeAccount,
    })) as typeof previous;
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0] = { ...paired.targets[0]!, engine: "claude", model: "haiku" };
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_unsafe_provider_home",
    }, undefined, { command: stub("throw new Error('should not launch')") });
    expect(outcome).toMatchObject({ outcome: "declined", reason: "profile_error" });
    expect(readAnswerRecord(paired.id, "target_1", "rq_unsafe_provider_home")?.admitted).toBe(false);
    expect(completions).toHaveLength(1);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    accountManager.resolveHeadlessSpawn = previous;
    if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
    else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
    await server.close();
  }
});
test("heartbeats continue through silence, newest progress is sent, completion frees slot", async () => {
  const beats: { seq: number; progress: { label: string } | null }[] = [];
  const completed: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats.push(body as typeof beats[number]);
      return { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/complete")) {
      completed.push(body);
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404 };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'First'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Checking notes'}}));await Bun.sleep(2300);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:'m1'}));`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    const request = {
      ...sampleRequest,
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2 },
    };
    expect(advertisedSlots(paired)).toEqual([
      { target_id: "target_1", free: 1 },
    ]);
    const pending = runClaimedRequest(paired, request, undefined, {
      command: script,
    });
    await Bun.sleep(300);
    expect(advertisedSlots(paired)).toEqual([
      { target_id: "target_1", free: 0 },
    ]);
    const outcome = await pending;
    expect(outcome?.outcome).toBe("answered");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0].seq).toBe(1);
    expect(beats[1]!.progress!.label).toBe("Checking notes");
    /* The settings page reads the same label, kept in memory for the relay. */
    expect(relayActivity(paired.id).lastProgress).toMatchObject({ targetId: "target_1", label: "Checking notes" });
    expect(completed).toHaveLength(1);
    expect(runningCount(paired.id, "target_1")).toBe(0);
    expect(readRunLedger().runs).toEqual([]);
  } finally {
    await server.close();
  }
});
test("a full target is declined and a nonzero CLI exit cannot use a written answer", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) =>
    req.url?.endsWith("/complete")
      ? (completions.push(body),
        { body: { status: "accepted", duplicate: false } })
      : { body: { status: "ok" } },
  );
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));await Bun.sleep(700);process.exit(2);`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    const first = runClaimedRequest(
      paired,
      { ...sampleRequest, request_id: "rq_2" },
      undefined,
      { command: script },
    );
    await Bun.sleep(150);
    const busy = await runClaimedRequest(
      paired,
      { ...sampleRequest, request_id: "rq_3" },
      undefined,
      { command: script },
    );
    expect(busy).toMatchObject({ outcome: "declined", reason: "busy" });
    expect(await first).toMatchObject({
      outcome: "failed",
      reason: "agent_error",
    });
    expect(completions).toHaveLength(2);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    await server.close();
  }
});
test("a lost lease cancels the child and never completes", async () => {
  let completes = 0;
  const server = await startTestRelay((req) =>
    req.url?.endsWith("/heartbeat")
      ? {
          status: 409,
          body: { error: { code: "lease_lost", message: "gone" } },
        }
      : (completes++, { body: { status: "accepted", duplicate: false } }),
  );
  const script = stub(`await Bun.stdin.text();await Bun.sleep(5000);`);
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, request_id: "rq_4" },
      undefined,
      { command: script },
    );
    expect(outcome).toBeNull();
    expect(completes).toBe(0);
  } finally {
    await server.close();
  }
});
test("unacknowledged heartbeats stop the child after the stall window", async () => {
  let completes = 0;
  let beats = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats++;
      return { status: 503, body: { error: { code: "unavailable", message: "later" } } };
    }
    completes++;
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`await Bun.stdin.text();await Bun.sleep(30000);`);
  try {
    const paired = relay(`${server.origin}/v1`);
    const start = Date.now();
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_stalled",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 10 },
    }, undefined, { command: script, timeoutMs: 15000 });
    expect(outcome).toBeNull();
    expect(Date.now() - start).toBeLessThan(14000);
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(completes).toBe(0);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    await server.close();
  }
}, 20_000);
test("a ledger failure after launch stops the child before failed completion", async () => {
  let childPid: number | null = null;
  let childIdentity: string | null = null;
  let aliveAtCompletion = true;
  let groupAliveAtCompletion = true;
  let slotsAtCompletion = -1;
  let injected = false;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    aliveAtCompletion = processMatches(childPid, childIdentity);
    try {
      process.kill(-childPid!, 0);
    } catch {
      groupAliveAtCompletion = false;
    }
    slotsAtCompletion = advertisedSlots(paired)[0]?.free ?? -1;
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  const script = stub(`await Bun.stdin.text();await Bun.sleep(30000);`);
  try {
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_ledger_failure",
    }, undefined, {
      command: script,
      processIdentity: (pid) => {
        const identity = procBackend.processIdentity(pid);
        if (!injected) {
          injected = true;
          childPid = pid;
          childIdentity = identity;
          const file = externalRelayFile("runs");
          const original = fs.readFileSync(file, "utf8");
          fs.writeFileSync(file, "{broken");
          setTimeout(() => fs.writeFileSync(file, original), 0);
        }
        return identity;
      },
    });
    expect(injected).toBe(true);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(aliveAtCompletion).toBe(false);
    expect(groupAliveAtCompletion).toBe(false);
    expect(slotsAtCompletion).toBe(0);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    if (processMatches(childPid, childIdentity))
      terminateHeadlessReviewerGroup(childPid!, childIdentity);
    await server.close();
  }
}, 10_000);
test("a persistent ledger read error still releases the local slot", async () => {
  const requestId = "rq_ledger_unreadable";
  const ledgerFile = externalRelayFile("runs");
  let originalLedger: string | null = null;
  let childPid: number | null = null;
  let childIdentity: string | null = null;
  let completions = 0;
  const pairedServer = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions++;
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${pairedServer.origin}/v1`);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: requestId,
    }, undefined, {
      command: stub(`await Bun.stdin.text();await Bun.sleep(30000);`),
      processIdentity: (pid) => {
        const identity = procBackend.processIdentity(pid);
        if (originalLedger === null) {
          childPid = pid;
          childIdentity = identity;
          originalLedger = fs.readFileSync(ledgerFile, "utf8");
          fs.writeFileSync(ledgerFile, "{broken");
        }
        return identity;
      },
    });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(completions).toBe(1);
    expect(runningCount(paired.id, "target_1")).toBe(0);
    expect(errors.some((message) => message.startsWith("External relay run ledger cleanup failed"))).toBe(true);
  } finally {
    console.error = originalError;
    if (originalLedger !== null) {
      fs.writeFileSync(ledgerFile, originalLedger);
      dropRun(requestId);
    }
    if (processMatches(childPid, childIdentity))
      terminateHeadlessReviewerGroup(childPid!, childIdentity);
    await pairedServer.close();
  }
}, 10_000);
test("an acknowledged heartbeat still keeps the run alive after a delayed response", async () => {
  const completions: unknown[] = [];
  const started = Date.now();
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      if (Date.now() - started < 8000)
        return { status: 503, body: { error: { code: "unavailable", message: "later" } } };
      await Bun.sleep(3000);
      return { body: { status: "ok" } };
    }
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.sleep(12000);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_late_ack",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 10 },
    }, undefined, { command: script, timeoutMs: 18000 });
    expect(outcome?.outcome).toBe("answered");
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
}, 20_000);
test("Claude startup failure without init completes agent_error", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`await Bun.stdin.text();process.exit(2);`);
  try {
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0].engine = "claude";
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_claude_startup",
    }, undefined, { command: script });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
});
test("completion retry reuses the identical body after a lost response", async () => {
  const bodies: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    bodies.push(body);
    return bodies.length === 1
      ? { drop: true }
      : { body: { status: "accepted", duplicate: true } };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, request_id: "rq_5" },
      undefined,
      { command: script },
    );
    expect(outcome?.outcome).toBe("answered");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  } finally {
    await server.close();
  }
});
test("unknown request kind is declined as unsupported", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((_req, body) => {
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, kind: "summarize", request_id: "rq_kind" },
    );
    expect(outcome).toMatchObject({ outcome: "declined", reason: "unsupported_kind" });
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
});
test("404 heartbeat drops the lease and cancels the child", async () => {
  let completes = 0;
  const server = await startTestRelay((req) =>
    req.url?.endsWith("/heartbeat")
      ? { status: 404, body: { error: { code: "not_found", message: "gone" } } }
      : (completes++, { body: { status: "accepted", duplicate: false } }),
  );
  const script = stub(`await Bun.stdin.text();await Bun.sleep(5000);`);
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, request_id: "rq_404" },
      undefined,
      { command: script },
    );
    expect(outcome).toBeNull();
    expect(completes).toBe(0);
  } finally {
    await server.close();
  }
});
test("a duplicate claim leaves the held lease alone", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) =>
    req.url?.endsWith("/heartbeat")
      ? { body: { status: "ok" } }
      : (completions.push(body), { body: { status: "accepted", duplicate: false } }),
  );
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.sleep(500);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    const request = { ...sampleRequest, request_id: "rq_duplicate" };
    const first = runClaimedRequest(paired, request, undefined, { command: script });
    for (let i = 0; i < 30 && readRunLedger().runs.length === 0; i++) await Bun.sleep(20);
    expect(readRunLedger().runs.map((run) => run.requestId)).toContain(request.request_id);
    const routeCopy = await import("./runner.ts" + "?route-copy") as typeof import("./runner");
    expect(routeCopy.runningCount(paired.id, "target_1")).toBe(1);
    expect(await runClaimedRequest({ ...paired, paused: true }, request, undefined, { command: script })).toBeNull();
    expect(readRunLedger().runs.map((run) => run.requestId)).toContain(request.request_id);
    expect((await first)?.outcome).toBe("answered");
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
});
test("newly confirmed targets default to a 30 minute hard cap", async () => {
  const owner = {
    namespace: "test", id: "owner", display_name: "Owner", handle: null,
  };
  const target = {
    target_id: "target", name: "Target", answered_by: "install" as const,
    fallback: "service" as const,
  };
  const server = await startTestRelay(() => ({
    body: { credential: "x".repeat(43), version: 1, owner, targets: [target] },
  }));
  try {
    updateRelayStore((store) => ({
      ...store,
      pending: [{
        id: "pending_cap", origin: server.origin, api_base: `${server.origin}/v1`,
        name: "Test", description: "", limits: relay(`${server.origin}/v1`).limits,
        pairing_id: "pair_cap", poll_secret: "x".repeat(43),
        code: "1234-5678", verify_url: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        poll_interval_s: 2, owner, targets: [target],
      }],
    }));
    const confirmed = await confirmRelayPairing("pending_cap", owner.id);
    expect(confirmed.targets[0].hardCapMinutes).toBe(30);
  } finally {
    await server.close();
  }
});
test("exhausted account sends a retry hint in seconds", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((_req, body) => {
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  accountManager.resolveHeadlessSpawn = (() => ({
    kind: "exhausted", resetsAt: Math.floor(Date.now() / 1000) + 3600,
  })) as typeof original;
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_exhausted",
    });
    expect(outcome).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    expect(outcome?.outcome === "declined" && outcome.retry_after_s).toBeGreaterThanOrEqual(3598);
    expect(outcome?.outcome === "declined" && outcome.retry_after_s).toBeLessThanOrEqual(3600);
    expect(completions).toHaveLength(1);
  } finally {
    accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account })) as typeof original;
    await server.close();
  }
});
test("a note arriving during a heartbeat is sent on the next beat", async () => {
  const beats: { seq: number; progress: { label: string } | null }[] = [];
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats.push(body as typeof beats[number]);
      if (beats.length === 1) await Bun.sleep(450);
    }
    return { body: { status: "ok" } };
  });
  const script = stub(`await Bun.stdin.text();await Bun.sleep(100);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Still working'}}));await Bun.sleep(3000);const a=process.argv.slice(2);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_progress_race",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2 },
    }, undefined, { command: script });
    expect(outcome?.outcome).toBe("answered");
    expect(beats[0].progress).toBeNull();
    expect(beats.some((beat) => beat.progress?.label === "Still working")).toBe(true);
  } finally {
    await server.close();
  }
});
test("local answers and early declines survive recovery while completion is pending", async () => {
  for (const earlyDecline of [false, true]) {
    let received!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => { received = resolve; });
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const server = await startTestRelay(async (req) => {
      if (req.url?.endsWith("/complete")) {
        received();
        await acknowledgement;
        return { body: { status: "accepted", duplicate: false } };
      }
      return { body: { status: "ok" } };
    });
    const paired = relay(`${server.origin}/v1`);
    paired.paused = earlyDecline;
    const requestId = earlyDecline ? "rq_pending_decline" : "rq_pending_answer";
    const pending = runClaimedRequest(paired, { ...sampleRequest, request_id: requestId }, undefined, {
      command: stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`),
    });
    try {
      await seen;
      const record = readAnswerRecord(paired.id, "target_1", requestId);
      expect(record).toMatchObject({
        state: "finished", delivery: "unconfirmed", input: sampleRequest.input,
        outcome: earlyDecline ? "declined:disabled" : "answered",
        answer: earlyDecline ? null : { action: "reply", text: "Done", reply_to: null },
      });
      // The recovery path only settles unfinished model work; a persisted
      // local result keeps its answer and its uncertain original receipt.
      settleInterruptedAnswer(paired.id, "target_1", requestId, "refused");
      expect(readAnswerRecord(paired.id, "target_1", requestId)).toEqual(record);
      release();
      await pending;
      expect(readAnswerRecord(paired.id, "target_1", requestId)).toMatchObject({
        delivery: "accepted", answer: record?.answer, outcome: record?.outcome,
      });
    } finally {
      release();
      await pending;
      await server.close();
    }
  }
}, 15_000);

test("413 on an answer completes failed invalid_answer immediately", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return completions.length === 1
      ? { status: 413, body: { error: { code: "too_large", message: "large" } } }
      : { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_too_large",
    }, undefined, { command: script });
    expect(completions.map((body) => { const completion = body as { outcome: string; reason?: string }; return [completion.outcome, completion.reason]; })).toEqual([
      ["answered", undefined], ["failed", "invalid_answer"],
    ]);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(readAnswerRecord("relay_1", "target_1", "rq_too_large")).toMatchObject({
      outcome: "failed:invalid_answer", delivery: "accepted",
      answer: { action: "reply", text: "Done", reply_to: null },
    });
  } finally {
    await server.close();
  }
});
for (const engine of ["codex", "claude"] as const)
  test(`${engine} forbidden tool cancels the child and completes profile_violation`, async () => {
    const completions: unknown[] = [];
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
      completions.push(body);
      return { body: { status: "accepted", duplicate: false } };
    });
    const script = stub(engine === "codex"
      ? `await Bun.stdin.text();console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'false'}}));await Bun.sleep(5000);`
      : `await Bun.stdin.text();console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','Bash'],mcp_servers:[]}));await Bun.sleep(5000);`);
    const start = Date.now();
    try {
      const paired = relay(`${server.origin}/v1`);
      paired.targets[0].engine = engine;
      const outcome = await runClaimedRequest(paired, {
        ...sampleRequest, request_id: `rq_violation_${engine}`,
      }, undefined, { command: script });
      expect(outcome).toMatchObject({ outcome: "failed", reason: "profile_violation" });
      expect(completions).toHaveLength(1);
      expect(Date.now() - start).toBeLessThan(4000);
      expect(readRunLedger().runs).toEqual([]);
      expect(runningCount(paired.id, "target_1")).toBe(0);
    } finally {
      await server.close();
    }
  });
test("hard cap kills the child and completes failed hard_cap", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`await Bun.stdin.text();await Bun.sleep(5000);`);
  try {
    const paired = relay(`${server.origin}/v1`);
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_hard_cap",
    }, undefined, { command: script, timeoutMs: 300 });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "hard_cap" });
    expect(completions).toHaveLength(1);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    await server.close();
  }
});


test("relay advertises zero capacity and starts no answer child during drain, then admits after release", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const marker = path.join(root, "drain-child-marker");
  const command = stub(`const a=process.argv; await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "launched"); await Bun.write(a[a.indexOf('--output-last-message')+1], JSON.stringify({action:'reply', text:'Done', reply_to:'m1'}));`);
  const completed: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completed.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  const request = { ...sampleRequest, request_id: "rq_drain" };
  try {
    writeDrain(drainFile(), { id: "relay-hold", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    expect(await runClaimedRequest(paired, request, undefined, { command })).toMatchObject({ outcome: "declined", reason: "busy" });
    expect(fs.existsSync(marker)).toBe(false); expect(readRunLedger().runs).toEqual([]);
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 0 }]);
    releaseDrain(drainFile(), "relay-hold");
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 1 }]);
    expect(await runClaimedRequest(paired, { ...request, lease_id: "ls_released_Zq3vN8bY1xKp4Lm" }, undefined, { command })).toMatchObject({ outcome: "answered" });
    expect(fs.readFileSync(marker, "utf8")).toBe("launched");
    expect(completed).toHaveLength(2);
  } finally { releaseDrain(drainFile(), "relay-hold"); await server.close(); }
});

test("an answer admitted before drain completes normally while fresh children stay held", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const marker = path.join(root, "admitted-child-marker");
  const gate = path.join(root, "admitted-child-release");
  const command = stub(`const a=process.argv; await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "launched"); while(!require('node:fs').existsSync(${JSON.stringify(gate)})) await Bun.sleep(10); await Bun.write(a[a.indexOf('--output-last-message')+1], JSON.stringify({action:'reply', text:'Done', reply_to:'m1'}));`);
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const paired = relay(`${server.origin}/v1`);
  const pending = runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_admitted_drain" }, undefined, { command });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await Bun.sleep(10);
    expect(fs.existsSync(marker)).toBe(true);
    writeDrain(drainFile(), { id: "relay-admitted", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    fs.writeFileSync(gate, "release");
    expect(await pending).toMatchObject({ outcome: "answered" });
    expect(readRunLedger().runs).toEqual([]);
  } finally { fs.writeFileSync(gate, "release"); await pending; releaseDrain(drainFile(), "relay-admitted"); await server.close(); }
});

/** A Codex stub that answers with the hand-off action when its schema offers it, and records the schema and prompt it saw. */
function handoffStub(seen: string) {
  return stub(
    `const a=process.argv.slice(2);const prompt=await Bun.stdin.text();const schema=await Bun.file(a[a.indexOf('--output-schema')+1]).text();await Bun.write(${JSON.stringify(seen)},JSON.stringify({schema,prompt}));await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:schema.includes('handoff')?'handoff':'reply',text:'I will mute them',reply_to:'m1'}));`,
  );
}
test("a hand-off completes as declined/handoff with no text, and its exchange is recorded", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const seen = path.join(root, "handoff-seen.json");
  try {
    const paired = relay(`${server.origin}/v1`);
    const outcome = await runClaimedRequest(paired, { ...contextRequest, request_id: "rq_handoff" }, undefined, { command: handoffStub(seen) });
    const sent = { lease_id: sampleRequest.lease_id, outcome: "declined", reason: "handoff", detail: HANDOFF_DETAIL, retry_after_s: null };
    expect(outcome).toEqual(sent as typeof outcome);
    expect(completions).toEqual([sent]);
    const { schema, prompt } = JSON.parse(fs.readFileSync(seen, "utf8"));
    expect(JSON.parse(schema).properties.action.enum).toEqual(["reply", "ignore", "handoff"]);
    expect(prompt).toContain("<tools>");
    const record = readAnswerRecord(paired.id, "target_1", "rq_handoff");
    expect(record).toMatchObject({
      state: "finished",
      outcome: "declined:handoff",
      answer: { action: "handoff", text: "", reply_to: null },
      delivery: "accepted",
      engine: "codex",
      model: "gpt-6-sol",
      targetName: "Target",
    });
    // The input is kept as received, unknown fields included.
    expect(record?.input).toEqual(contextRequest.input);
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    // Neither the lease nor the credential is written into the record.
    const files = fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "external-relay/answers", paired.id, "target_1"));
    const text = files.map((name) => fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "external-relay/answers", paired.id, "target_1", name), "utf8")).join("");
    expect(text).not.toContain(sampleRequest.lease_id);
    expect(text).not.toContain(paired.credential);
  } finally {
    await server.close();
  }
});
test("without a tool index the schema and the answer stay as before", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const seen = path.join(root, "legacy-seen.json");
  try {
    const paired = relay(`${server.origin}/v1`);
    const outcome = await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_legacy_schema", answer: { max_chars: 100, progress: "none" } }, undefined, { command: handoffStub(seen) });
    expect(outcome).toMatchObject({ outcome: "answered", answer: { action: "reply", text: "I will mute them", reply_to: "m1" } });
    expect(JSON.parse(JSON.parse(fs.readFileSync(seen, "utf8")).schema).properties.action.enum).toEqual(["reply", "ignore"]);
    expect(readAnswerRecord(paired.id, "target_1", "rq_legacy_schema")).toMatchObject({
      outcome: "answered", answer: { action: "reply", text: "I will mute them" }, delivery: "accepted",
    });
  } finally {
    await server.close();
  }
});
test("declines, lost leases and refused completions are recorded too", async () => {
  let completeStatus = 200;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat"))
      return req.url.includes("rq_rec_lost")
        ? { status: 409, body: { error: { code: "lease_lost", message: "gone" } } }
        : { body: { status: "ok" } };
    return completeStatus === 200
      ? { body: { status: "accepted", duplicate: false } }
      : { status: completeStatus, body: { error: { code: "lease_lost", message: "gone" } } };
  });
  try {
    const paired = relay(`${server.origin}/v1`);
    paired.paused = true;
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_rec_paused" })).toMatchObject({ reason: "disabled" });
    expect(readAnswerRecord(paired.id, "target_1", "rq_rec_paused")).toMatchObject({ state: "finished", outcome: "declined:disabled", answer: null, delivery: "accepted", engine: null });
    paired.paused = false;
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_rec_lost" }, undefined, { command: stub(`await Bun.stdin.text();await Bun.sleep(5000);`) })).toBeNull();
    expect(readAnswerRecord(paired.id, "target_1", "rq_rec_lost")).toMatchObject({ state: "finished", outcome: "lease_lost", delivery: null, engine: "codex" });
    completeStatus = 409;
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_rec_refused", kind: "other" })).toMatchObject({ reason: "unsupported_kind" });
    expect(readAnswerRecord(paired.id, "target_1", "rq_rec_refused")).toMatchObject({ outcome: "declined:unsupported_kind", delivery: "refused" });
    // A request whose ids cannot name a file is answered and not recorded.
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "../escape", target_id: "../x" })).toMatchObject({ reason: "invalid_request" });
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "external-relay/answers", paired.id, "..", "x"))).toBe(false);
    const listed = listAnswerRecords(paired.id, "target_1").map((row) => row.requestId);
    expect(listed.slice(0, 3)).toEqual(["rq_rec_refused", "rq_rec_lost", "rq_rec_paused"]);
  } finally {
    await server.close();
  }
}, 15_000);

test("every relay answer runs with the native web search, and the record says so", async () => {
  const server = await startTestRelay((req) => ({ body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } }));
  const argsFile = path.join(root, "web-search-args.json");
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(${JSON.stringify(argsFile)},JSON.stringify(a));await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_web_search" }, undefined, { command: script })).toMatchObject({ outcome: "answered" });
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toContain("web_search=live");
    expect(readAnswerRecord(paired.id, "target_1", "rq_web_search")).toMatchObject({ profile: { webSearch: true }, admitted: true, requester: null });
  } finally {
    await server.close();
  }
});
test("the member limit declines a member past it, per chat, and never counts the owner or admins", async () => {
  const completions: { reason?: string; detail?: string | null; retry_after_s?: number | null }[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body as never);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  const ask = (n: number, requester: Record<string, unknown> | null, chat = "chat_key_aaaaaaaaaaaa", target?: Partial<PairedRelay["targets"][number]>) => {
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0] = { ...paired.targets[0]!, id: "target_limit", memberLimitPerHour: 2, ...target };
    return runClaimedRequest(paired, {
      ...sampleRequest, request_id: `rq_limit_${n}`, target_id: paired.targets[0]!.id, chat: { key: chat },
      input: { ...sampleRequest.input, requester },
    }, undefined, { command: script });
  };
  const member = { key: "u_m", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_owner: false, is_anonymous_admin: false };
  try {
    expect(await ask(1, member)).toMatchObject({ outcome: "answered" });
    expect(await ask(2, member)).toMatchObject({ outcome: "answered" });
    const third = await ask(3, member);
    expect(third).toMatchObject({ outcome: "declined", reason: "member_limit", detail: memberLimitDetail(2) });
    const retry = (third as { retry_after_s: number }).retry_after_s;
    expect(retry).toBeGreaterThan(3500);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(readAnswerRecord("relay_1", "target_limit", "rq_limit_3")).toMatchObject({
      outcome: "declined:member_limit", admitted: false, chatKey: "chat_key_aaaaaaaaaaaa",
      requester: member,
    });
    // Another chat counts on its own; admins and the owner are not counted.
    expect(await ask(4, member, "chat_key_bbbbbbbbbbbb")).toMatchObject({ outcome: "answered" });
    expect(await ask(5, { ...member, is_admin: true })).toMatchObject({ outcome: "answered" });
    expect(await ask(6, { ...member, is_owner: true })).toMatchObject({ outcome: "answered" });
    // Another member is not affected; 0 and null are no limit; no requester block is never counted.
    expect(await ask(7, { ...member, key: "u_other" })).toMatchObject({ outcome: "answered" });
    expect(await ask(8, member, undefined, { memberLimitPerHour: 0 })).toMatchObject({ outcome: "answered" });
    expect(await ask(9, member, undefined, { memberLimitPerHour: null })).toMatchObject({ outcome: "answered" });
    expect(await ask(10, null)).toMatchObject({ outcome: "answered" });
    // A former admin or owner starts their member count with their first member run.
    const roleChangeChat = "chat_key_changedaaaaa";
    expect(await ask(11, { ...member, is_admin: true }, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "answered" });
    expect(await ask(12, { ...member, is_owner: true }, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "answered" });
    expect(await ask(13, member, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "answered" });
    expect(await ask(14, member, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "declined", reason: "member_limit" });
    expect(completions.filter((body) => body.reason === "member_limit")).toHaveLength(2);
  } finally {
    await server.close();
  }
}, 60_000);

test("pre-launch capacity and drain declines leave the member's allowance available", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_admission";
  paired.targets[0]!.memberLimitPerHour = 2;
  const requester = { key: "u_member", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_anonymous_admin: false, is_owner: false };
  const request = (id: string) => ({ ...sampleRequest, request_id: id, chat: { key: "chat_key_admissionaa" }, input: { ...sampleRequest.input, requester } });
  const command = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  const previous = accountManager.resolveHeadlessSpawn;
  try {
    accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: null })) as typeof previous;
    expect(await runClaimedRequest(paired, request("rq_before_capacity"), undefined, { command })).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    // Acquire the drain after reservation/account selection, exercising the
    // second check immediately before the profile and child are built.
    accountManager.resolveHeadlessSpawn = (() => {
      writeDrain(drainFile(), { id: "admission-hold", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
      return { kind: "available", account };
    }) as typeof previous;
    expect(await runClaimedRequest(paired, request("rq_before_drain"), undefined, { command })).toMatchObject({ outcome: "declined", reason: "busy" });
    releaseDrain(drainFile(), "admission-hold");
    accountManager.resolveHeadlessSpawn = previous;
    for (const id of ["rq_before_capacity", "rq_before_drain"])
      expect(readAnswerRecord(paired.id, "target_1", id)?.admitted).toBe(false);
    for (const id of ["rq_after_capacity", "rq_after_drain"])
      expect(await runClaimedRequest(paired, request(id), undefined, { command })).toMatchObject({ outcome: "answered" });
    expect(await runClaimedRequest(paired, request("rq_after_allowance"), undefined, { command })).toMatchObject({ outcome: "declined", reason: "member_limit" });
  } finally {
    accountManager.resolveHeadlessSpawn = previous;
    releaseDrain(drainFile(), "admission-hold");
    await server.close();
  }
});

test("launched hand-offs, failed agents and running agents each consume the member limit", async () => {
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_count_launched";
  paired.targets[0] = { ...paired.targets[0]!, concurrency: 2, memberLimitPerHour: 1 };
  const requester = { key: "u_member", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_anonymous_admin: false, is_owner: false };
  const request = (id: string, chatKey: string) => ({ ...contextRequest, request_id: id, chat: { key: chatKey }, input: { ...contextRequest.input, requester } });
  const handoff = handoffStub(path.join(root, "admission-handoff"));
  const failure = stub("process.exit(1)");
  const release = path.join(root, "admission-release");
  const running = stub(`const a=process.argv.slice(2);await Bun.stdin.text();while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(10);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  let pending: ReturnType<typeof runClaimedRequest> | undefined;
  try {
    for (const [kind, command, outcome] of [
      ["handoff", handoff, "declined"], ["failed", failure, "failed"],
    ] as const) {
      const chat = `chat_key_${kind}_aaaaa`;
      const id = `rq_launched_${kind}`;
      expect(await runClaimedRequest(paired, request(id, chat), undefined, { command })).toMatchObject({ outcome, reason: kind === "handoff" ? "handoff" : "agent_error" });
      expect(readAnswerRecord(paired.id, "target_1", id)?.admitted).toBe(true);
      expect(await runClaimedRequest(paired, request(`${id}_limited`, chat), undefined, { command })).toMatchObject({ outcome: "declined", reason: "member_limit" });
    }
    const chat = "chat_key_runningaaaa";
    pending = runClaimedRequest(paired, request("rq_launched_running", chat), undefined, { command: running });
    const deadline = Date.now() + 5000;
    while (!readAnswerRecord(paired.id, "target_1", "rq_launched_running")?.admitted && Date.now() < deadline) await Bun.sleep(10);
    expect(readAnswerRecord(paired.id, "target_1", "rq_launched_running")).toMatchObject({ state: "running", admitted: true });
    expect(countMemberAnswers({ relayId: paired.id, targetId: "target_1", chatKey: chat, requesterKey: requester.key, sinceMs: Date.now() - 3600000 }).count).toBe(1);
    expect(await runClaimedRequest(paired, request("rq_running_limited", chat), undefined, { command: running })).toMatchObject({ outcome: "declined", reason: "member_limit" });
  } finally {
    fs.writeFileSync(release, "release");
    await pending;
    await server.close();
  }
}, 30_000);

test("service-built roles answer and the real runner and poller emit cross-check bodies", async () => {
  const { ensureExternalRelayPollers, stopExternalRelayPollers } = await import("./poller");
  const completions: unknown[] = [];
  let claimBody: unknown;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: "t_target", name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url?.endsWith("/claim")) {
      claimBody = body;
      stopExternalRelayPollers();
      return { status: 204 };
    }
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_wire";
  paired.targets[0] = { ...paired.targets[0]!, id: "t_target", memberLimitPerHour: null };
  const command = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  const fixture = (role: string) => serviceClaims.find(({ name }) => name === `claimed_rc_${role}.json`)!.body.request;
  try {
    for (const role of ["member", "admin", "owner", "anonymous_admin"]) {
      const request = { ...fixture(role), request_id: `rq_wire_${role}` };
      expect(await runClaimedRequest(paired, request, undefined, { command })).toMatchObject({ outcome: "answered" });
      expect(readAnswerRecord(paired.id, "t_target", request.request_id)).toMatchObject({
        requester: request.input.requester, input: request.input, admitted: true,
      });
    }
    const member = fixture("member");
    const handoff = await runClaimedRequest(paired, { ...member, request_id: "rq_wire_handoff" }, undefined, { command: handoffStub(path.join(root, "wire-handoff-seen")) });
    expect(handoff).toMatchObject({ outcome: "declined", reason: "handoff", detail: HANDOFF_DETAIL, retry_after_s: null });

    paired.id = "relay_wire_limit";
    paired.targets[0]!.memberLimitPerHour = 1;
    expect(await runClaimedRequest(paired, { ...member, request_id: "rq_wire_first" }, undefined, { command })).toMatchObject({ outcome: "answered" });
    const limited = await runClaimedRequest(paired, { ...member, request_id: "rq_wire_limit" }, undefined, { command });
    expect(limited).toMatchObject({ outcome: "declined", reason: "member_limit", detail: "This member reached 1 answer in the last hour in this chat." });
    expect(limited?.outcome === "declined" && limited.retry_after_s).toBeGreaterThan(3500);
    expect(limited?.outcome === "declined" && [...limited.detail!].length).toBeLessThanOrEqual(200);
    // These fixtures use the same key as the counted member; the role flags exempt them.
    for (const role of ["admin", "owner"])
      expect(await runClaimedRequest(paired, { ...fixture(role), request_id: `rq_wire_exempt_${role}`, input: { ...fixture(role).input, requester: { ...fixture(role).input.requester, key: member.input.requester.key } } }, undefined, { command })).toMatchObject({ outcome: "answered" });

    updateRelayStore((store) => ({ ...store, relays: [paired] }));
    ensureExternalRelayPollers();
    const deadline = Date.now() + 5000;
    while (!claimBody && Date.now() < deadline) await Bun.sleep(10);
    expect(claimBody).toEqual({ wait_s: 25, kinds: ["answer"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions"], slots: [{ target_id: "t_target", free: 1 }] });
    const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_completions.json"), "utf8"));
    expect(handoff).toEqual(expected.handoff);
    expect(claimBody).toEqual(expected.claim_body);
    // The absolute retry duration depends on the clock between launches.
    // Check its range above and compare the stable wire fields here.
    expect({ ...limited, retry_after_s: expected.member_limit.retry_after_s }).toEqual(expected.member_limit);
    expect(completions.filter((body) => ["handoff", "member_limit"].includes((body as { reason?: string }).reason ?? "")))
      .toEqual([handoff, limited]);
    if (process.env.LLV_RELAY_WIRE_OUTPUT) {
      fs.mkdirSync(path.dirname(process.env.LLV_RELAY_WIRE_OUTPUT), { recursive: true });
      fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT, JSON.stringify({
        handoff, member_limit: limited, claim_body: claimBody,
        completions_on_wire: completions.filter((body) => ["handoff", "member_limit"].includes((body as { reason?: string }).reason ?? "")),
      }, null, 2) + "\n");
    }
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
}, 60_000);

// Slice 2a uses the real launchDetached command and relayCall HTTP seams.
function loopStub(plan: string, seen: string) {
  return stub(`import fs from 'node:fs';const a=process.argv.slice(2);const p=await Bun.stdin.text();
const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8'));
const round=Number(p.match(/This is round (\\d+) of 8/)?.[1]??1);
const results=JSON.parse(p.match(/<tool_results>\\n([^]*?)\\n<\\/tool_results>/)?.[1]??'[]');
const final=!schema.properties.calls;
fs.appendFileSync(${JSON.stringify(seen)},JSON.stringify({round,prompt:p,schema,cwd:process.cwd()})+'\\n');
const call=(tool='search_docs',args={query:'meetup'},cursor=null)=>({tool,arguments:JSON.stringify(args),cursor});
const reply={action:'reply',text:'The meetup is Friday.',reply_to:'m_b40b71a0a9d43622ee0e2e6a',...(final?{}:{calls:[]})};
const answer=(()=>{${plan}})();
if(answer!==undefined)await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify(answer));`);
}
const oneCallPlan = `return round===1?{action:'call',text:'',reply_to:null,calls:[call()]}:reply;`;
type WireCall = ReturnType<typeof callBody>;
async function runLoopCase(options: {
  live?: { engine: "codex" | "claude"; home: string };
  role?: string; request?: ReturnType<typeof x1Request>; plan?: string;
  response?: (body: WireCall, attempt: number) => { status?: number; body?: unknown; drop?: boolean } | Promise<{ status?: number; body?: unknown; drop?: boolean }>;
  completeResponse?: (body: unknown, attempt: number) => { status?: number; body?: unknown };
  runtime?: ToolLoopRuntime;
  relayId?: string; ownerTier?: boolean;
  reverseReadArrival?: boolean;
  heartbeatResponse?: (seq: number) => { status?: number; body?: unknown };
}) {
  const request = options.request ?? { ...x1Request(options.role ?? "member"), request_id: `loop_${crypto.randomUUID()}` };
  const calls: WireCall[] = [];
  const events: string[] = [];
  const heartbeats: unknown[] = [];
  const completions: unknown[] = [];
  const seen = path.join(root, `loop-seen-${crypto.randomUUID()}`);
  const originalHttpRequest = http.request;
  let releaseFirstSend: (() => void) | undefined;
  let toolPosts = 0;
  if (options.reverseReadArrival) http.request = ((...args: Parameters<typeof http.request>) => {
    const outgoing = originalHttpRequest(...args);
    const requestOptions = args[0] as http.RequestOptions;
    if (requestOptions.path?.endsWith("/tool-calls") && toolPosts++ === 0) {
      const end = outgoing.end;
      outgoing.end = ((...endArgs: Parameters<typeof outgoing.end>) => {
        releaseFirstSend = () => { end.apply(outgoing, endArgs); };
        return outgoing;
      }) as typeof outgoing.end;
    }
    return outgoing;
  }) as typeof http.request;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      const seq = (body as { seq: number }).seq;
      events.push(`beat:${seq}`);
      heartbeats.push(body);
      if (options.heartbeatResponse) return options.heartbeatResponse(seq);
    }
    if (req.url?.endsWith("/complete")) { completions.push(body); if (options.completeResponse) return options.completeResponse(body, completions.length); }
    if (req.url?.endsWith("/tool-calls")) {
      events.push("call");
      calls.push(body as WireCall);
      if (calls.length === 1) releaseFirstSend?.();
      return options.response ? await options.response(body as WireCall, calls.length) : {
        body: { ...x1Results.ok, call_id: (body as WireCall).call_id, calls_remaining: 16 - new Set(calls.map((call) => call.call_id)).size },
      };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.id = options.relayId ?? `loop_${crypto.randomUUID()}`;
  paired.targets[0] = { ...paired.targets[0]!, id: request.target_id, memberLimitPerHour: null, ...(options.ownerTier !== undefined ? { ownerTier: options.ownerTier } : {}) };
  const previousSelection = accountManager.resolveHeadlessSpawn;
  const restoreFeatures = options.live ? setCodexFeatureReaderForTest(undefined) : undefined;
  if (options.live) {
    paired.targets[0] = { ...paired.targets[0]!, engine: options.live.engine,
      model: options.live.engine === "codex" ? "gpt-6-sol" : "haiku", effort: "low", hardCapMinutes: 2 };
    const liveAccount: AccountContext = { engine: options.live.engine, accountId: `synthetic_probe_${options.live.engine}`, kind: "managed",
      home: options.live.home, transcriptRoot: root, env: { ...process.env } };
    accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account: liveAccount })) as typeof previousSelection;
  }
  try {
    const completion = await runClaimedRequest(paired, request, undefined, { ...(options.live ? {} : { command: loopStub(options.plan ?? oneCallPlan, seen) }),
      sleep: async () => {}, ...options.runtime });
    const rounds = fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    expect(events.indexOf("beat:1")).toBeLessThan(events.indexOf("call") === -1 ? Infinity : events.indexOf("call"));
    expect(readRunLedger().runs).toEqual([]);
    return { completion, calls, events, heartbeats, rounds, completions, paired, request,
      record: readAnswerRecord(paired.id, request.target_id, request.request_id) };
  } finally { http.request = originalHttpRequest; restoreFeatures?.(); accountManager.resolveHeadlessSpawn = previousSelection; await server.close(); }
}

for (const role of ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_admin"])
  test(`X1 ${role} claim completes through the read loop`, async () => {
    const run = await runLoopCase({ role });
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(run.calls).toHaveLength(1);
    expect(run.rounds).toHaveLength(2);
    expect(run.record).toMatchObject({ rounds: 2, toolCalls: [{ round: 1, tool: "search_docs", status: "ok", local: false }] });
    const stored = JSON.stringify(run.record);
    for (const secret of [run.calls[0]!.call_id, run.request.lease_id, run.paired.credential, x1Results.ok!.output]) expect(stored).not.toContain(secret);
    expect(run.record!.toolCalls![0]).not.toHaveProperty("arguments");
  });

for (const [name, sample] of Object.entries(x1Results))
  test(`X1 result ${name} crosses the runner projection`, async () => {
    // Even an unexpected action result must end calling safely; no action is sent.
    const run = await runLoopCase({
      response: (body, attempt) => ({ body: { ...(sample.status === "pending" && attempt > 1 ? x1Results.ok : sample), tool: "search_docs", call_id: body.call_id } }),
    });
    expect(run.completion).toMatchObject({ outcome: "answered" });
    const prompt = run.rounds[1].prompt as string;
    const projected = JSON.parse(prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)![1]!)[0];
    if (sample.audience) {
      expect(projected).toMatchObject({ status: "denied", code: "not_permitted", output: "" });
      expect(run.record!.toolCalls![0]!.withheld).toBe(true);
      expect(run.calls).toHaveLength(1);
    } else if (sample.status === "pending") {
      expect(run.calls).toHaveLength(2);
      expect(run.calls[1]).toEqual(run.calls[0]);
      expect(projected.output).toBe(x1Results.ok!.output);
    } else {
      expect(projected.status).toBe(sample.status);
      expect(projected.output).toBe(sample.output);
      if (sample.code) expect(projected.code).toBe(sample.code);
      expect(run.calls).toHaveLength(name === "unavailable" ? 3 : 1);
    }
    if (sample.delivered || sample.status === "outcome_unknown" || sample.code === "too_many_calls")
      expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
  });

for (const [name, envelope] of Object.entries(x1Errors).filter(([name]) => name !== "handoff_after_action"))
  test(`X1 transport ${name} uses the production HTTP path`, async () => {
    const waits: number[] = [];
    const run = await runLoopCase({ response: () => envelope, runtime: { sleep: async (ms) => { waits.push(ms); } } });
    if (["lease_lost", "not_found"].includes(name)) {
      expect(run.completion).toBeNull();
      expect(run.completions).toEqual([]);
      expect(run.record?.outcome).toBe("lease_lost");
    } else {
      expect(run.completion).toMatchObject({ outcome: "answered" });
      expect(run.rounds[1].prompt).toContain(`"code":"${name}"`);
      if (["unauthorized", "unsupported_version"].includes(name)) expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
      if (name === "rate_limited") expect(waits).toEqual([60000, 60000, 60000]);
    }
  });

for (const rejection of ["unauthorized", "unsupported_version"])
  test(`${rejection} cancels a sibling poll wait and completes one normal final round`, async () => {
    let waiting!: () => void;
    const siblingWaiting = new Promise<void>((resolve) => { waiting = resolve; });
    const run = await runLoopCase({
      plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('search_docs',{query:'reject'}),call('search_docs',{query:'sibling'})]}:reply;`,
      response: async (body) => {
        if ("arguments" in body && body.arguments?.query === "reject") {
          await siblingWaiting;
          return x1Errors[rejection]!;
        }
        return { body: { ...x1Results.pending, tool: "search_docs", call_id: body.call_id, retry_after_s: 60 } };
      },
      runtime: { sleep: async (ms, signal) => { waiting(); await toolSleep(ms, signal); } },
    });
    expect(run.calls).toHaveLength(2);
    expect(run.completions).toHaveLength(1);
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(run.rounds).toHaveLength(2);
    expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
    expect(run.record?.outcome).toBe("answered");
    expect(run.record?.toolCalls?.map((call) => call.code)).toEqual([rejection, rejection]);
  });

test("exhausting the call budget still polls an already admitted read", async () => {
  const run = await runLoopCase({ response: (body, attempt) => ({ body: {
    ...(attempt === 1 ? x1Results.pending : x1Results.ok), tool: "search_docs", call_id: body.call_id, calls_remaining: 0,
  } }) });
  expect(run.calls).toHaveLength(2);
  expect(run.calls[0]).toEqual(run.calls[1]);
  expect(run.completions).toHaveLength(1);
  expect(run.completion).toMatchObject({ outcome: "answered" });
  expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
  expect(run.rounds[1].prompt).toContain(x1Results.ok!.output.replaceAll('"', '\\"'));
});

test("six requested calls send four, invalid arguments and forbidden tools stay local", async () => {
  const run = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:Array.from({length:6},(_,i)=>call('search_docs',{query:String(i)}))}:reply;` });
  expect(run.calls).toHaveLength(4);
  expect(run.record!.toolCalls!.slice(4).map((item) => item.code)).toEqual(["too_many_calls", "too_many_calls"]);
  const local = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('missing'),{tool:'search_docs',arguments:'[]',cursor:null},call('search_docs',{},'invented'),call('search_docs',{query:'x'.repeat(65536)})]}:reply;` });
  expect(local.calls).toHaveLength(0);
  expect(local.record!.toolCalls!.map((item) => item.code)).toEqual(["not_permitted", "invalid_arguments", "invalid_arguments", "invalid_arguments"]);
});
test("sixteen calls force a final schema, and sparse calls force round eight", async () => {
  for (const n of [1, 4]) {
    const run = await runLoopCase({ plan: `return final?reply:{action:'call',text:'',reply_to:null,calls:Array.from({length:${n}},(_,i)=>call('search_docs',{query:round+'-'+i}))};` });
    expect(run.calls).toHaveLength(n === 4 ? 16 : 7);
    expect(run.rounds).toHaveLength(n === 4 ? 5 : 8);
    expect(run.rounds.at(-1).schema).toEqual(handoffAnswerSchema);
  }
});
test("repeat calls use the local result, empty calls force the next round final", async () => {
  const run = await runLoopCase({ plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call()]}:reply;` });
  expect(run.calls).toHaveLength(1);
  const empty = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[]}:reply;` });
  expect(empty.calls).toHaveLength(0);
  expect(empty.rounds[1].schema).toEqual(handoffAnswerSchema);
});
test("a pending read stops at 330 seconds through the wait seam", async () => {
  let clock = 0;
  const run = await runLoopCase({ response: (body) => ({ body: { ...x1Results.pending, tool: "search_docs", call_id: body.call_id } }),
    runtime: { now: () => clock, sleep: async (ms) => { clock += ms; } } });
  expect(clock).toBe(330000);
  expect(run.rounds[1].prompt).toContain("The read did not finish.");
});
test("only 64 KiB of distinct outputs reaches subsequent prompts", async () => {
  const run = await runLoopCase({
    plan: `return final?reply:{action:'call',text:'',reply_to:null,calls:Array.from({length:4},(_,i)=>call('search_docs',{query:round+'-'+i}))};`,
    response: (body) => ({ body: { ...x1Results.ok, call_id: body.call_id, output: "😀".repeat(16000), calls_remaining: 16 } }),
  });
  const prompt = run.rounds.at(-1).prompt as string;
  const results = JSON.parse(prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)![1]!);
  expect(results.reduce((bytes: number, result: { output: string }) => bytes + Buffer.byteLength(result.output), 0)).toBeLessThanOrEqual(65536);
  expect(results.some((result: { code?: string }) => result.code === "quota_exhausted")).toBe(true);
});
test("a later Codex round cannot reuse a previous answer file", async () => {
  const run = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call()]}:undefined;` });
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "agent_error" });
  expect(run.rounds[0].cwd).not.toBe(run.rounds[1].cwd);
});

test("C4 X2 marks only the stored outcome of an admitted call as replayed", () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8"));
  const [media, docs, page] = evidence.calls;
  expect(media.attempts[0].request).toEqual(media.attempts[1].request);
  expect(media.attempts[0].response).toMatchObject({ status: "pending", replayed: false });
  expect(media.attempts[1].response).toMatchObject({ status: "ok", replayed: true });
  expect(docs.attempts[0].response.replayed).toBe(false);
  expect(page.attempts[0].response.replayed).toBe(false);
});

for (const reverseArrival of [false, true])
test(`X2 is generated by the real poller and runner with X1 pending and pages (${reverseArrival ? "reversed" : "normal"} arrivals)`, async () => {
  const { ensureExternalRelayPollers, stopExternalRelayPollers } = await import("./poller");
  const request = x1Request("member");
  const plannedCalls = [
    { round: 1, body: callBody(request, { tool: "get_media", arguments: { message_id: "m_b40b71a0a9d43622ee0e2e6a" } }) },
    { round: 1, body: callBody(request, { tool: "search_docs", arguments: { query: "meetup" } }) },
    { round: 2, body: callBody(request, { cursor: x1Results.cursor_page!.cursor! }) },
  ];
  // Allocate fixture slots and admission snapshots in round/model-item order.
  const calls: { round: number; attempts: { request: WireCall; x1_sample: string; response: ToolCallResult }[] }[] =
    plannedCalls.map(({ round }) => ({ round, attempts: [] }));
  const seenIds = new Set<string>();
  let admitRoundOne!: () => void;
  const roundOneAdmitted = new Promise<void>((resolve) => { admitRoundOne = resolve; });
  let claimBody: unknown;
  let heartbeat = false;
  const arrivals: string[] = [];
  const originalHttpRequest = http.request;
  let releaseFirstSend: (() => void) | undefined;
  let toolPosts = 0;
  if (reverseArrival) http.request = ((...args: Parameters<typeof http.request>) => {
    const outgoing = originalHttpRequest(...args);
    const options = args[0] as http.RequestOptions;
    if (options.path?.endsWith("/tool-calls") && toolPosts++ === 0) {
      const end = outgoing.end;
      outgoing.end = ((...endArgs: Parameters<typeof outgoing.end>) => {
        releaseFirstSend = () => { end.apply(outgoing, endArgs); };
        return outgoing;
      }) as typeof outgoing.end;
    }
    return outgoing;
  }) as typeof http.request;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: request.target_id, name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url?.endsWith("/claim")) { claimBody = body; stopExternalRelayPollers(); return { status: 204 }; }
    if (req.url?.endsWith("/heartbeat")) heartbeat = true;
    if (req.url?.endsWith("/tool-calls")) {
      expect(heartbeat).toBe(true);
      const call = body as WireCall;
      arrivals.push("cursor" in call ? "page" : call.tool);
      if ("tool" in call && call.tool === "search_docs") releaseFirstSend?.();
      const first = !seenIds.has(call.call_id);
      seenIds.add(call.call_id);
      const index = plannedCalls.findIndex((planned) => planned.body.call_id === call.call_id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(call).toEqual(plannedCalls[index]!.body);
      // Both concurrent reads are admitted before either can start polling.
      if (seenIds.size >= 2) admitRoundOne();
      await roundOneAdmitted;
      const sample = "cursor" in call ? "last_page" : call.tool === "search_docs" ? "ok" : first ? "pending" : "cursor_page";
      const response = { ...x1Results[sample]!, call_id: call.call_id, calls_remaining: first ? 15 - index : 14,
        replayed: !first };
      const entry = calls[index]!;
      entry.attempts.push({ request: call, x1_sample: sample, response });
      return { body: response };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_x2";
  paired.targets[0] = { ...paired.targets[0]!, id: request.target_id, memberLimitPerHour: null };
  try {
    updateRelayStore((store) => ({ ...store, relays: [paired] }));
    ensureExternalRelayPollers();
    const deadline = Date.now() + 5000;
    while (!claimBody && Date.now() < deadline) await Bun.sleep(10);
    expect(claimBody).toEqual({ wait_s: 25, kinds: ["answer"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions"], slots: [{ target_id: request.target_id, free: 1 }] });
    const completion = await runClaimedRequest(paired, request, undefined, { sleep: async () => {}, command: loopStub(
      `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('get_media',{message_id:'m_b40b71a0a9d43622ee0e2e6a'}),call()]};
       if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('get_media',{},results.find(r=>r.next_cursor).next_cursor)]};return reply;`,
      path.join(root, "x2-seen")) });
    expect(completion?.outcome).toBe("answered");
    if (reverseArrival) expect(arrivals.slice(0, 2)).toEqual(["search_docs", "get_media"]);
    if (completion?.outcome !== "answered") throw new Error("X2 did not answer");
    expect(completion.duration_ms).toBeGreaterThanOrEqual(0);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const x2Rounds = fs.readFileSync(path.join(root, "x2-seen"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const hashes = { prompts: x2Rounds.slice(-3).map((r) => hash(r.prompt)), schemas: x2Rounds.slice(-3).map((r) => hash(JSON.stringify(r.schema))),
      calls: calls.flatMap((entry) => entry.attempts.map((attempt) => hash(JSON.stringify(attempt.request)))) };
    const hashFile = path.join(x1Dir, "actions-off-x2-2a-hashes.json");

    const output = JSON.stringify({ x1: { revision: "a0d9245bcac2c2246f29f180f8bd21aa825d478c", claim: "claimed_tools_member.json",
      claim_sha256: createHash("sha256").update(fs.readFileSync(path.join(x1Dir, "claimed_tools_member.json"))).digest("hex") },
      claim_body: claimBody, calls, completion: { ...completion, duration_ms: 0 },
      ...(JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8")).actions ? { actions: JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8")).actions } : {}) }, null, 2) + "\n";
    const readWire = JSON.parse(output);
    delete readWire.actions;
    readWire.claim_body.features = readWire.claim_body.features.filter((feature: string) => feature !== "relay_tool_actions");
    expect({ ...hashes, wire: hash(JSON.stringify(readWire, null, 2) + "\n") })
      .toEqual(JSON.parse(fs.readFileSync(hashFile, "utf8")));
    if (process.env.LLV_RELAY_WIRE_OUTPUT_TOOL_LOOP) fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT_TOOL_LOOP, output);
    expect(output).toBe(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8"));
    expect(calls[0]!.attempts[0]!.request).toEqual(calls[0]!.attempts[1]!.request);
    expect(calls[2]!.attempts[0]!.request).toEqual({ lease_id: request.lease_id, call_id: calls[2]!.attempts[0]!.request.call_id, cursor: x1Results.cursor_page!.cursor! });
  } finally { http.request = originalHttpRequest; stopExternalRelayPollers(); await server.close(); }
}, 30_000);

test("C6 re-claim sends the stored call identity under a new lease and counts the member once", async () => {
  const request = { ...x1Request("member"), request_id: "rq_reclaim_read" };
  const relayId = "relay_reclaim_read";
  let first: WireCall | undefined;
  let executions = 0;
  const lost = await runLoopCase({ request, relayId, response: (body) => {
    first = body; executions++; return x1Errors.lease_lost!;
  } });
  expect(lost.completion).toBeNull();
  const reclaimed = await runLoopCase({ request: { ...request, lease_id: "b".repeat(64) }, relayId,
    response: (body) => {
      expect(body.call_id).toBe(first!.call_id);
      if (body.call_id !== first!.call_id) executions++;
      return { body: { ...x1Results.ok, call_id: body.call_id, replayed: true } };
    } });
  expect(reclaimed.completion).toMatchObject({ outcome: "answered" });
  expect(executions).toBe(1);
  expect(countMemberAnswers({ relayId, targetId: request.target_id, chatKey: request.chat!.key,
    requesterKey: request.input.requester!.key, sinceMs: Date.now() - 3600000 }).count).toBe(1);
});

test("heartbeats span the pending phase between child rounds", async () => {
  const request = { ...x1Request("member"), request_id: "rq_pending_beats",
    liveness: { ...x1Request("member").liveness, heartbeat_interval_s: 2 } };
  const run = await runLoopCase({ request, response: (body, attempt) => ({ body: {
    ...(attempt === 1 ? x1Results.pending : x1Results.ok), tool: "search_docs", call_id: body.call_id,
  } }), runtime: { sleep: async (ms) => { await Bun.sleep(ms); } } });
  expect(run.events.indexOf("beat:2")).toBeGreaterThan(run.events.indexOf("call"));
  expect(run.events).toContain("beat:3");
  expect(run.calls[0]).toEqual(run.calls[1]);
}, 20_000);

test("a stalled lease aborts a call phase and sends no completion", async () => {
  const request = { ...x1Request("member"), request_id: "rq_stalled_call",
    liveness: { ...x1Request("member").liveness, heartbeat_interval_s: 2, stall_window_s: 10 } };
  const run = await runLoopCase({ request, response: async (body) => {
    await Bun.sleep(12000); return { body: { ...x1Results.ok, call_id: body.call_id } };
  }, heartbeatResponse: (seq) => seq === 1 ? { body: { status: "ok" } } : { status: 503 } });
  expect(run.completion).toBeNull();
  expect(run.completions).toEqual([]);
  expect(run.record!.outcome).toBe("lease_lost");
}, 25_000);

for (const role of ["admin", "owner", "anonymous_admin"])
  test(`audience projection for ${role} permits only its own flags`, async () => {
    for (const audience of ["admin", "owner"] as const) {
      const sample = x1Results[audience]!;
      const run = await runLoopCase({ role, response: (body) => ({ body: { ...sample, tool: "search_docs", call_id: body.call_id } }) });
      const allowed = audience === "admin" || role === "owner";
      expect(run.record!.toolCalls![0]!.withheld).toBe(!allowed);
      const result = JSON.parse(run.rounds[1].prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)[1])[0];
      expect(result.output).toBe(allowed ? sample.output : "");
    }
  });

test("slice 1 requests launch with unchanged prompt/schema, no calls and no loop record fields", async () => {
  const { answerPrompt } = await import("./prompt");
  const { answerSchema } = await import("./protocol");
  for (const fixture of serviceClaims) {
    const request = requestSchema.parse(fixture.body.request);
    const run = await runLoopCase({ request, plan: "return reply;" });
    expect(run.rounds[0].prompt).toBe(answerPrompt(request));
    expect(run.rounds[0].schema).toEqual(request.input.tools?.length ? handoffAnswerSchema : answerSchema);
    expect(run.calls).toEqual([]);
    expect(run.record).not.toHaveProperty("rounds");
    expect(run.record).not.toHaveProperty("toolCalls");
  }
  const readRequest = x1Request("member");
  const request = { ...readRequest, request_id: "rq_handoff_only", input: { ...readRequest.input, tool_guidance: null,
    tools: readRequest.input.tools!.map((tool) => ({ name: tool.name, summary: tool.summary, mode: "handoff" as const })) } };
  const run = await runLoopCase({ request, plan: "return reply;" });
  expect(run.calls).toEqual([]);
  expect(run.rounds[0].prompt).toBe(answerPrompt(request));
  expect(run.record).not.toHaveProperty("rounds");
});

test("concurrent reads settle in model order with at most four in flight", async () => {
  let active = 0;
  let maximum = 0;
  const run = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:Array.from({length:4},(_,i)=>call('search_docs',{query:String(i)}))}:reply;`,
    response: async (body) => {
      active++; maximum = Math.max(maximum, active);
      const query = "arguments" in body ? body.arguments!.query as string : "";
      await Bun.sleep((4 - Number(query)) * 20); active--;
      return { body: { ...x1Results.ok, call_id: body.call_id, output: query, calls_remaining: 12 } };
    } });
  expect(maximum).toBe(4);
  const results = JSON.parse(run.rounds[1].prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)[1]);
  expect(results.map((item: { output: string }) => item.output)).toEqual(["0", "1", "2", "3"]);
});

test("transport and invalid-result retries keep identical bodies", async () => {
  for (const kind of ["5xx", "bad_result", "oversize_response"]) {
    const waits: number[] = [];
    const run = await runLoopCase({ response: (body, attempt) => {
      if (attempt < 4) {
        if (kind === "5xx") return { status: 503 };
        if (kind === "oversize_response") return { body: { ...x1Results.ok, output: "x".repeat(65537), call_id: body.call_id } };
        return { body: { ...x1Results.ok, status: "unexpected", call_id: body.call_id } };
      }
      return { body: { ...x1Results.ok, call_id: body.call_id } };
    }, runtime: { sleep: async (ms) => { waits.push(ms); } } });
    expect(run.calls).toHaveLength(4);
    expect(run.calls.every((body) => JSON.stringify(body) === JSON.stringify(run.calls[0]))).toBe(true);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(run.completion).toMatchObject({ outcome: "answered" });
  }
});

test("a historical replay cannot restore the fresh remaining-call budget", async () => {
  const run = await runLoopCase({ plan: `if(final)return reply;return round<=2?{action:'call',text:'',reply_to:null,calls:[call('search_docs',{query:String(round)})]}:reply;`,
    response: (body, attempt) => ({ body: { ...x1Results.ok, call_id: body.call_id, calls_remaining: attempt === 1 ? 2 : 15, replayed: attempt === 2 } }) });
  expect(run.rounds[2].prompt).toContain("2 calls are left.");
});

// Captured on the slice 2a head before changing the loop; only deterministic wire surfaces.
test("actions OFF preserves every 2a round, schema and call byte", async () => {
  const hashes: Record<string, unknown> = {};
  for (const role of ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_off"]) {
    const request = x1Request(role === "actions_off" ? "actions_admin" : role);
    if (role === "actions_off") request.input.tools = request.input.tools!.map((tool) => tool.effect === "action"
      ? { name: tool.name, summary: tool.summary, mode: "handoff" as const } : tool);
    const run = await runLoopCase({ request });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    hashes[role] = { prompts: run.rounds.map((r) => hash(r.prompt)), schemas: run.rounds.map((r) => hash(JSON.stringify(r.schema))),
      calls: run.calls.map((call) => hash(JSON.stringify(call))) };
    expect(run.record!.toolCalls!.every((row) => !("effect" in row))).toBe(true);
  }
  const file = path.join(x1Dir, "actions-off-2a-hashes.json");
  if (process.env.LLV_RELAY_CAPTURE_2A) fs.writeFileSync(file, JSON.stringify(hashes, null, 2) + "\n");
  expect(hashes).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
});

const actionPlan = (tool: string, final = "reply") =>
  `return round===1?{action:'call',text:'',reply_to:null,calls:[call('${tool}',{})]}:${final};`;
const projectionsOf = (run: Awaited<ReturnType<typeof runLoopCase>>, round = 1) =>
  JSON.parse(run.rounds[round].prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)[1]);
const actionResponse = (sample: string, body: WireCall) => ({ body: {
  ...x1Results[sample]!, call_id: body.call_id, tool: "tool" in body ? body.tool : x1Results[sample]!.tool,
} });

test("a post-execution switch-off denial prevents a changed-reason ban after switch-on", async () => {
  let actionsEnabled = true;
  const executed = new Set<string>();
  const run = await runLoopCase({ role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('ban_participant',{
      target_message_id:'m_b40b71a0a9d43622ee0e2e6a',reason:round===1?'Spam':'Repeated spam'})]}:reply;`,
    response: (body) => {
      expect(actionsEnabled).toBe(true);
      executed.add(body.call_id);
      actionsEnabled = false;
      // Exact output of Celestia's withhold_action_result at dcc35137,
      // apps/backend/application/usecase/clones/relay_tool_call.py:115.
      const withheld = { call_id: body.call_id, tool: "ban_participant", status: "denied", output: "",
        truncated: false, effect: "action", delivered: false, replayed: false, calls_remaining: 15, code: "not_permitted" };
      actionsEnabled = true;
      return { body: withheld };
    } });
  expect(executed.size).toBe(1);
  expect(run.calls).toHaveLength(1);
  expect(projectionsOf(run)[0]).toMatchObject({ status: "denied", code: "not_permitted", effect: "action" });
  expect(run.rounds[1].schema).toEqual(answerSchema);
  // Even a model that ignores the final schema cannot issue another ban or hand off.
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
  expect(run.completions).toHaveLength(1);
});

for (const choice of ["reply", "call", "handoff", "ignore"])
  test(`an exhausted unavailable replay preserves the completed ban's uncertainty with ${choice}`, async () => {
    const executed = new Set<string>();
    const run = await runLoopCase({ role: "actions_admin",
      plan: `if(round===1||'${choice}'==='call'&&!final)return {action:'call',text:'',reply_to:null,calls:[call('ban_participant',{
        target_message_id:'m_b40b71a0a9d43622ee0e2e6a',reason:round===1?'Spam':'Repeated spam'})]};
        if('${choice}'==='call')return {action:'call',text:'',reply_to:null,calls:[call('ban_participant',{reason:'Repeated spam'})]};
        return '${choice}'==='reply'?{...reply,text:'The ban may have happened; I will not repeat it.'}:{action:'${choice}',text:'',reply_to:null};`,
      response: (body) => {
        if (!executed.has(body.call_id)) {
          executed.add(body.call_id);
          return { drop: true }; // Ban finished, but its first HTTP result was lost.
        }
        // Celestia reauthorizes a saved ok result before replaying it. The
        // pinned dispatcher returns this denial when that check is unavailable.
        return { body: { call_id: body.call_id, tool: "ban_participant", status: "denied", output: "",
          truncated: false, effect: "action", delivered: false, replayed: true, calls_remaining: 15,
          code: "unavailable", retry_after_s: 1 } };
      } });
    expect(executed.size).toBe(1);
    expect(run.calls).toHaveLength(4);
    expect(new Set(run.calls.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(projectionsOf(run)[0]).toMatchObject({ status: "denied", code: "unavailable", effect: "action", execution_unknown: true });
    expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
    expect(run.rounds[1].prompt).toContain("execution_unknown means the action may have happened");
    expect(run.rounds).toHaveLength(2);
    expect(run.record!.toolCalls![0]).toMatchObject({ status: "denied", code: "unavailable", replayed: true, local: false });
    expect(run.completion).toMatchObject(choice === "reply" ? { outcome: "answered" } : { outcome: "failed", reason: "invalid_answer" });
    expect(run.completions).toHaveLength(1);
  });

for (const sample of ["action_ok", "action_error", "action_denied", "confirmation_pending", "outcome_unknown", "action_replayed", "action_delivered"])
  test(`X1 ${sample} crosses the real action loop`, async () => {
    const wire = x1Results[sample]!;
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan(wire.tool),
      runtime: { now: () => Date.parse("2026-01-01T00:00:00Z") }, response: (body) => actionResponse(sample, body) });
    expect(run.calls).toHaveLength(1);
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(projectionsOf(run)[0]).toMatchObject({ status: wire.status, effect: "action", output: wire.output });
    const schema = run.rounds[1].schema;
    expect(schema.properties.action.enum).not.toContain("handoff");
    if (sample === "outcome_unknown") expect(schema).toEqual(replyAnswerSchema);
    else if (wire.delivered || wire.status === "confirmation_pending" || wire.status === "denied") expect(schema).toEqual(answerSchema);
    else expect(schema.properties.action.enum).toContain("call");
    if (wire.delivered) expect(projectionsOf(run)[0].delivered).toBe(true);
    if (sample === "confirmation_pending") {
      expect(projectionsOf(run)[0].summary).toBe(wire.summary);
      expect(projectionsOf(run)[0].expires_in_s).toBe(Math.max(0, Math.ceil((Date.parse(wire.expires_at!) - Date.parse("2026-01-01T00:00:00Z")) / 1000)));
      expect(projectionsOf(run)[0]).not.toHaveProperty("confirmation_id");
    }
    expect(run.record!.toolCalls![0]).toMatchObject({ effect: "action", local: false });
    for (const field of ["output", "summary", "confirmation_id", "arguments", "call_id", "lease_id", "credential"])
      expect(run.record!.toolCalls![0]).not.toHaveProperty(field);
  });

for (const choice of ["ignore", "handoff"])
  test(`an unknown action rejects ${choice} even if the model ignores its schema`, async () => {
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("generate_video", `{action:'${choice}',text:'',reply_to:null}`),
      response: (body) => actionResponse("outcome_unknown", body) });
    expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(run.completions).toHaveLength(1);
    expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
  });

test("handoff_after_action completion is resent as failed/invalid_answer", async () => {
  const run = await runLoopCase({ plan: `return {action:'handoff',text:'',reply_to:null,calls:[]};`,
    completeResponse: (_body, attempt) => attempt === 1 ? x1Errors.handoff_after_action! : { body: { status: "ok" } } });
  expect(run.completions).toHaveLength(2);
  expect(run.completions[0]).toMatchObject({ outcome: "declined", reason: "handoff" });
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
  expect(run.record?.delivery).toBe("accepted");
});

test("action repeats in one round and later rounds join one execution", async () => {
  const run = await runLoopCase({ role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('react_to_message',{})]}:reply;`,
    response: (body) => actionResponse("action_ok", body) });
  expect(run.calls).toHaveLength(1);
  expect(projectionsOf(run, 2)).toHaveLength(1);
  expect(run.record!.toolCalls).toHaveLength(4);
});

test("a second action is local and can be requested after the first result", async () => {
  const run = await runLoopCase({ role: "actions_admin", plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('ban_participant',{})]};
    if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('ban_participant',{})]};return reply;`,
    response: (body) => actionResponse("action_ok", body) });
  expect(run.calls.map((body) => "tool" in body && body.tool)).toEqual(["react_to_message", "ban_participant"]);
  expect(run.record!.toolCalls![1]).toMatchObject({ local: true, code: "too_many_calls", effect: "action" });
});

test("reads settle before an action even when the model lists the action first", async () => {
  let settledReads = 0;
  const run = await runLoopCase({ role: "actions_admin", plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('search_docs',{query:'a'}),call('search_docs',{query:'b'})]}:reply;`,
    response: async (body) => {
      if ("tool" in body && body.tool === "search_docs") {
        await Bun.sleep(20); settledReads++; return { body: { ...x1Results.ok, call_id: body.call_id } };
      }
      expect(settledReads).toBe(2); return actionResponse("action_ok", body);
    } });
  expect(run.calls.map((body) => "tool" in body && body.tool)).toEqual(["search_docs", "search_docs", "react_to_message"]);
  expect(projectionsOf(run).map((p: { tool: string }) => p.tool)).toEqual(["react_to_message", "search_docs", "search_docs"]);
});

for (const failure of ["transport", "malformed", "503_then_400", "call_conflict", "pending_deadline", "ambiguous_429", "ambiguous_413", "pending_then_400", "malformed_then_400", "five_xx", "oversized_response", "wrong_tool"])
  test(`${failure} cannot prove an action fate and ends calling`, async () => {
    let clock = 0;
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("react_to_message"),
      runtime: { now: () => clock, sleep: async (ms) => { clock += ms; } },
      response: (body, attempt) => {
        if (failure === "pending_deadline") return actionResponse("action_pending", body);
        if (failure === "call_conflict") return x1Errors.call_conflict!;
        if (failure === "malformed") return { body: { ...x1Results.action_ok, call_id: "wrong" } };
        if (failure === "transport") return { drop: true };
        if (failure === "five_xx") return { status: 503 };
        if (failure === "oversized_response") return { body: { ...x1Results.action_ok, call_id: body.call_id, output: "x".repeat(65537) } };
        if (failure === "wrong_tool") return { body: { ...x1Results.action_ok, call_id: body.call_id, tool: "generate_image" } };
        if (failure === "pending_then_400") return attempt === 1 ? actionResponse("action_pending", body) : { status: 400 };
        if (failure === "malformed_then_400") return attempt === 1 ? { body: "malformed" } : { status: 400 };
        return attempt === 1 ? { status: 503 } : { status: failure === "503_then_400" ? 400 : failure === "ambiguous_413" ? 413 : 429, body: { error: { code: "refused" } } };
      } });
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(projectionsOf(run)[0]).toMatchObject({ status: "outcome_unknown", effect: "action" });
    expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
    expect(new Set(run.calls.map((call) => JSON.stringify(call))).size).toBe(1);
    expect(run.record!.toolCalls![0]).toMatchObject({ status: "outcome_unknown", local: true, effect: "action" });
    if (["transport", "malformed"].includes(failure)) expect(run.calls).toHaveLength(4);
    if (failure === "pending_deadline") expect(clock).toBe(330000);
  });

for (const unresolved of [302, 408, 418, 409])
  for (const refusal of [400, 401, 413, 426, 429])
    test(`an unresolved ${unresolved} then ${refusal} prevents a changed-reason ban`, async () => {
      const executed = new Set<string>();
      const run = await runLoopCase({ role: "actions_admin",
        plan: `if(final)return reply;return round<=2?{action:'call',text:'',reply_to:null,calls:[call('ban_participant',{
          target_message_id:'m_b40b71a0a9d43622ee0e2e6a',reason:round===1?'Spam':'Repeated spam'})]}:reply;`,
        response: (body, attempt) => {
          if (attempt === 1) {
            executed.add(body.call_id);
            return { status: unresolved, body: { error: { code: "unexpected_response" } } };
          }
          if (body.call_id === [...executed][0]) return { status: refusal, body: { error: { code: "refused" } } };
          executed.add(body.call_id);
          return actionResponse("action_ok", body);
        } });
      expect(executed.size).toBe(1);
      expect(run.calls).toHaveLength(refusal === 429 ? 4 : 2);
      expect(new Set(run.calls.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(projectionsOf(run)[0]).toMatchObject({ status: "outcome_unknown", effect: "action" });
      expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
      expect(run.rounds).toHaveLength(2);
      expect(run.record!.toolCalls![0]).toMatchObject({ status: "outcome_unknown", local: true });
      expect(run.completion).toMatchObject({ outcome: "answered" });
    });

for (const status of [400, 413, 429, 401, 426])
  test(`pre-admission ${status} alone remains an action error`, async () => {
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("react_to_message"),
      response: () => ({ status, body: { error: { code: "refused" } } }) });
    expect(projectionsOf(run)[0]).toMatchObject({ status: "error", effect: "action" });
    expect(run.rounds[1].schema.properties.action.enum).not.toContain("handoff");
    if ([401, 426].includes(status)) expect(run.rounds[1].schema).toEqual(answerSchema);
  });

for (const rejection of ["unauthorized", "unsupported_version"])
  for (const first of ["pending", "transport", "503"])
    test(`an action's ${first} then ${rejection} preserves uncertainty and rejects ignore`, async () => {
      const run = await runLoopCase({ role: "actions_admin",
        plan: actionPlan("react_to_message", `{action:'ignore',text:'',reply_to:null}`),
        response: (body, attempt) => attempt > 1 ? x1Errors[rejection]!
          : first === "pending" ? actionResponse("action_pending", body)
          : first === "transport" ? { drop: true } : { status: 503 } });
      expect(run.calls).toHaveLength(2);
      expect(run.calls[0]).toEqual(run.calls[1]);
      expect(projectionsOf(run)[0]).toMatchObject({ status: "outcome_unknown", effect: "action" });
      expect(run.record!.toolCalls![0]).toMatchObject({ status: "outcome_unknown", local: true });
      expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
      expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
      expect(run.completions).toHaveLength(1);
    });

for (const status of ["ok", "error"])
  for (const pendingRemaining of [15, 0])
    test(`a replayed action ${status} with zero ends calls after polling pending with ${pendingRemaining} left`, async () => {
      const run = await runLoopCase({ role: "actions_admin",
        plan: `if(final)return reply;return round<=2?{action:'call',text:'',reply_to:null,calls:[call(round===1?'generate_voice':'react_to_message',{})]}:reply;`,
        response: (body, attempt) => ({ body: {
          ...actionResponse(attempt === 1 ? "action_pending" : "action_error", body).body,
          status: attempt === 1 ? "pending" : status, delivered: false,
          calls_remaining: attempt === 1 ? pendingRemaining : 0, replayed: attempt > 1,
        } }) });
      expect(run.calls).toHaveLength(2);
      expect(run.calls[0]).toEqual(run.calls[1]);
      expect(projectionsOf(run)[0]).toMatchObject({ status, effect: "action" });
      expect(run.rounds).toHaveLength(2);
      expect(run.rounds[1].schema).toEqual(answerSchema);
      expect(run.completion).toMatchObject({ outcome: "answered" });
    });

test("a positive historical action replay keeps the fresh remaining-call budget", async () => {
  const run = await runLoopCase({ role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{message_id:String(round)})]}:reply;`,
    response: (body, attempt) => ({ body: { ...actionResponse("action_ok", body).body,
      calls_remaining: attempt === 1 ? 2 : 15, replayed: attempt === 2 } }) });
  expect(run.calls).toHaveLength(2);
  expect(run.rounds[2].prompt).toContain("2 calls are left.");
  expect(run.rounds[2].schema.properties.action.enum).toContain("call");
  expect(run.completion).toMatchObject({ outcome: "answered" });
});

test("C6 action identity survives a new lease with one execution", async () => {
  const request = { ...x1Request("actions_admin"), request_id: "rq_reclaim_action" };
  let first: WireCall | undefined;
  let executions = 0;
  const lost = await runLoopCase({ request, plan: actionPlan("generate_image"), response: (body) => {
    first = body; executions++; return x1Errors.lease_lost!;
  } });
  expect(lost.completion).toBeNull(); expect(lost.completions).toEqual([]); expect(lost.calls).toHaveLength(1);
  const reclaimed = await runLoopCase({ request: { ...request, lease_id: "b".repeat(64) }, plan: actionPlan("generate_image"), response: (body) => {
    expect(body.call_id).toBe(first!.call_id);
    if (body.call_id !== first!.call_id) executions++;
    return actionResponse("action_replayed", body);
  } });
  expect(reclaimed.completion).toMatchObject({ outcome: "answered" }); expect(executions).toBe(1);
});

test("an action cannot hand off after a denial or after a terminal result", async () => {
  for (const sample of ["action_denied", "action_delivered"]) {
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan(x1Results[sample]!.tool, `{action:'handoff',text:'',reply_to:null,calls:[]}`),
      response: (body) => actionResponse(sample, body) });
    expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(run.completions).toHaveLength(1);
  }
});

test("confirmation expiry is projected at zero and is never polled", async () => {
  const wire = x1Results.confirmation_pending!;
  const run = await runLoopCase({ role: "actions_admin", plan: actionPlan(wire.tool),
    runtime: { now: () => Date.parse(wire.expires_at!) + 1000 }, response: (body) => actionResponse("confirmation_pending", body) });
  expect(projectionsOf(run)[0]).toMatchObject({ expires_in_s: 0, summary: wire.summary });
  expect(run.calls).toHaveLength(1);
});

test("member flags remove admin actions from the prompt, schema and wire", async () => {
  const request = x1Request("actions_admin"); request.input.requester = x1Request("member").input.requester;
  const run = await runLoopCase({ request, plan: actionPlan("ban_participant") });
  expect(run.rounds[0].schema.properties.calls.items.properties.tool.enum).not.toContain("ban_participant");
  const tools = JSON.parse(run.rounds[0].prompt.match(/<tools>\n([^]*?)\n<\/tools>/)[1]);
  expect(tools.some((tool: { name: string }) => tool.name === "ban_participant")).toBe(false);
  expect(run.calls).toEqual([]);
  expect(run.record!.toolCalls![0]).toMatchObject({ code: "not_permitted", local: true });
});

test("action progress hides restricted tool names and shows unrestricted actions", async () => {
  for (const tool of ["ban_participant", "react_to_message"]) {
    const request = x1Request("actions_admin"); request.answer.progress = "notes"; request.liveness.heartbeat_interval_s = 2;
    const run = await runLoopCase({ request, plan: actionPlan(tool),
      runtime: { sleep: async (ms) => { await Bun.sleep(ms); } }, response: (body, attempt) => actionResponse(attempt === 1 ? "action_pending" : "action_ok", body) });
    // Real heartbeats carry only the loop's permitted progress labels.
    const activity = JSON.stringify(run.heartbeats);
    expect(activity).not.toContain("ban_participant");
    if (tool === "react_to_message") expect(activity).toContain("react_to_message");
  }
}, 20_000);


test("heartbeat lease loss between reads and an action prevents the action and completion", async () => {
  const request = x1Request("actions_admin"); request.liveness.heartbeat_interval_s = 2;
  const run = await runLoopCase({ request,
    plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('search_docs',{query:'meetup'})]}:reply;`,
    response: async (body) => { await Bun.sleep(2400); return { body: { ...x1Results.ok, call_id: body.call_id } }; },
    heartbeatResponse: (seq) => seq === 1 ? { body: { status: "ok" } } : x1Errors.lease_lost! });
  expect(run.calls).toHaveLength(1); expect(run.calls[0]).toHaveProperty("tool", "search_docs");
  expect(run.events).toContain("beat:2"); expect(run.completion).toBeNull(); expect(run.completions).toEqual([]);
}, 10_000);

for (const reverseReadArrival of [false, true])
test(`X2 actions are generated by the real runner using the service fixtures (${reverseReadArrival ? "reversed" : "normal"} arrivals)`, async () => {
  const runs: unknown[] = [];
  const plans = [
    { name: "action_and_confirmation", plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('search_chat_messages',{query:'spam'}),call('search_docs',{query:'meetup'}),call('react_to_message',{emoji:'👍',message_id:'m_b40b71a0a9d43622ee0e2e6a'})]};
      if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('request_kick_participant',{reason:'Repeated spam',target_message_id:'m_b40b71a0a9d43622ee0e2e6a'})]};
      return {...reply,text:'Removal is waiting for confirmation in the chat.',reply_to:null};` },
    { name: "delivered_generation", plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('generate_image',{prompt:'A quiet forest'})]}:{action:'ignore',text:'',reply_to:null};` },
    { name: "outcome_unknown", plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('generate_video',{prompt:'A quiet forest at dawn'})]}:{...reply,text:'The video may have been sent; I will not try again.',reply_to:null};` },
  ];
  for (const { name, plan } of plans) {
    const request = x1Request("actions_admin");
    const tools = name === "action_and_confirmation"
      ? ["search_chat_messages", "search_docs", "react_to_message", "request_kick_participant"]
      : [name === "delivered_generation" ? "generate_image" : "generate_video"];
    // Admission slots and budgets follow model order, independently of HTTP arrival.
    const calls: { round: number; attempts: { request: WireCall; x1_sample: string; response: ToolCallResult }[] }[] =
      tools.map((tool) => ({ round: tool === "request_kick_participant" ? 2 : 1, attempts: [] }));
    const stored = new Map<string, ToolCallResult>();
    const executions = new Map<string, number>();
    let admitReads!: () => void;
    const readsAdmitted = new Promise<void>((resolve) => { admitReads = resolve; });
    const run = await runLoopCase({ request, plan, reverseReadArrival: reverseReadArrival && name === "action_and_confirmation",
      runtime: { now: () => Date.parse("2026-10-07T12:00:00Z") },
      response: async (body) => {
        if (!("tool" in body) || !body.tool) throw new Error("X2 action has no tool");
        const index = tools.indexOf(body.tool);
        expect(index).toBeGreaterThanOrEqual(0);
        const first = !stored.has(body.call_id);
        const sample = body.tool === "search_chat_messages" ? "admin" : body.tool === "search_docs" ? "ok"
          : body.tool === "react_to_message" ? "action_ok"
          : body.tool === "request_kick_participant" ? "confirmation_pending" : body.tool === "generate_video" ? "outcome_unknown"
          : first ? "action_pending" : "action_delivered";
        if (first) {
          executions.set(body.call_id, (executions.get(body.call_id) ?? 0) + 1);
          const terminal = body.tool === "generate_image" ? x1Results.action_delivered! : x1Results[sample]!;
          stored.set(body.call_id, { ...terminal, call_id: body.call_id,
            calls_remaining: terminal.calls_remaining === 0 ? 0 : 15 - index });
        }
        if (name === "action_and_confirmation" && index < 2) {
          if (stored.size >= 2) admitReads();
          await readsAdmitted;
        }
        const response = first
          ? { ...x1Results[sample]!, call_id: body.call_id, calls_remaining: x1Results[sample]!.calls_remaining === 0 ? 0 : 15 - index, replayed: false }
          : { ...stored.get(body.call_id)!, replayed: true };
        expect(response.tool).toBe(body.tool!);
        calls[index]!.attempts.push({ request: body, x1_sample: sample, response });
        return { body: response };
      } });
    expect([...executions.values()].every((count) => count === 1)).toBe(true);
    expect(run.completion?.outcome).toBe("answered");
    if (run.completion?.outcome !== "answered") throw new Error("X2 action did not answer");
    expect(run.completion.duration_ms).toBeGreaterThanOrEqual(0);
    if (name === "action_and_confirmation") {
      expect(run.calls.map((call) => "tool" in call && call.tool)).toEqual(reverseReadArrival
        ? ["search_docs", "search_chat_messages", "react_to_message", "request_kick_participant"]
        : ["search_chat_messages", "search_docs", "react_to_message", "request_kick_participant"]);
      expect(run.rounds).toHaveLength(3);
    } else expect(run.rounds).toHaveLength(2);
    if (name === "delivered_generation") {
      expect(run.calls[0]).toEqual(run.calls[1]);
      expect(calls[0]!.attempts[0]!.response).toMatchObject({ status: "pending", replayed: false });
      expect(calls[0]!.attempts[1]!.response).toMatchObject({ status: "ok", delivered: true, replayed: true });
      expect(executions.get(run.calls[0]!.call_id)).toBe(1);
    }
    runs.push({ name, x1: { claim: "claimed_tools_actions_admin.json", claim_sha256: createHash("sha256").update(fs.readFileSync(path.join(x1Dir, "claimed_tools_actions_admin.json"))).digest("hex") },
      calls, completion: { ...run.completion, duration_ms: 0 } });
  }
  const file = path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json");
  const expected = JSON.parse(fs.readFileSync(file, "utf8"));
  if (process.env.LLV_RELAY_WIRE_OUTPUT_ACTIONS) fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT_ACTIONS, JSON.stringify({ ...expected, actions: runs }, null, 2) + "\n");
  expect(runs).toEqual(expected.actions);
});

// Opt-in live-model checks use only the local fake; credentials remain in the profile's auth source.
for (const engine of ["codex", "claude"] as const)
  for (const task of ["react", "meetup"])
    (process.env.LLV_RELAY_LIVE_ACTION_PROBE === "1" ? test : test.skip)(`${engine} live model ${task} uses only the requested action`, async () => {
      const accountHome = process.env[engine === "codex" ? "LLV_RELAY_LIVE_CODEX_HOME" : "LLV_RELAY_LIVE_CLAUDE_HOME"];
      if (!accountHome) throw new Error("live action probe account home is required");
      const request = x1Request("actions_admin");
      request.request_id = `rq_live_synthetic_${engine}_${task}`;
      request.input.tools = request.input.tools!.filter((tool) => ["react_to_message", "search_docs"].includes(tool.name));
      request.input.tool_guidance = null;
      request.input.instructions = "Answer the requester briefly using the supplied tools when needed.";
      request.input.request_text = task === "react" ? "React with 👍 to message m_b40b71a0a9d43622ee0e2e6a." : "When is the meetup?";
      request.input.short_term_memory = null;
      request.input.documents = [];
      request.input.conversation = [];
      const run = await runLoopCase({ request, live: { engine, home: accountHome }, response: (body) => {
        if ("tool" in body && body.tool === "react_to_message") return actionResponse("action_ok", body);
        return { body: { ...x1Results.ok, call_id: body.call_id, output: "The meetup is Friday." } };
      } });
      expect(run.completion).toMatchObject({ outcome: "answered" });
      const actions = run.calls.filter((call) => "tool" in call && call.tool === "react_to_message");
      expect(actions).toHaveLength(task === "react" ? 1 : 0);
    }, 180_000);


test("a read effect returned for an indexed action never restores handoff", async () => {
  const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("generate_image", `{action:'handoff',text:'',reply_to:null,calls:[]}`),
    response: (body) => ({ body: { ...x1Results.not_permitted, call_id: body.call_id, tool: "generate_image" } }) });
  expect(projectionsOf(run)[0]).toMatchObject({ effect: "action", status: "denied", code: "not_permitted" });
  expect(run.rounds[1].schema.properties.action.enum).not.toContain("handoff");
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
});

// Captured by replaying the accepted slice 2b runner before enabling any slice 3 path.
test("slice 3 dark and ineligible paths preserve the slice 2b wire and records", async () => {
  const fixtureFile = path.join(x1Dir, "switches-off-2b-hashes.json");
  const snapshot = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const cases = ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_admin", "action_react", "action_ban"];
  const surfaces: Record<string, unknown> = {};
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  async function replay(role: string, ownerTier?: boolean) {
    const request = x1Request(role.startsWith("action_") ? "actions_admin" : role);
    const run = await runLoopCase({ request, ownerTier, relayId: "baseline_relay", ...(role.startsWith("action_") ? { plan: actionPlan(role === "action_react" ? "react_to_message" : "ban_participant") } : {}) });
    const record = { ...run.record, startedAt: "time", finishedAt: "time", durationMs: 0 };
    const view = (await import("./store")).publicRelay({ ...run.paired, origin: "https://fixture.example", api_base: "https://fixture.example/v1", pairedAt: "time" });
    if (ownerTier !== undefined) delete view.targets[0]!.ownerTier;
    return { prompts: run.rounds.map((r) => hash(r.prompt)), schemas: run.rounds.map((r) => hash(JSON.stringify(r.schema))), calls: run.calls.map((call) => hash(JSON.stringify(call))), record: hash(JSON.stringify(record)), view: hash(JSON.stringify(view)) };
  }
  for (const role of cases) surfaces[role] = await replay(role);
  if (process.env.LLV_RELAY_CAPTURE_2B) { fs.writeFileSync(process.env.LLV_RELAY_CAPTURE_2B, JSON.stringify({ ...snapshot, surfaces }, null, 2) + "\n"); return; }
  expect(surfaces).toEqual(snapshot.surfaces);
  for (const role of cases.filter(r => r !== "owner")) expect(await replay(role, true)).toEqual(snapshot.surfaces[role]);
  const { setRelaySwitch } = await import("./switches");
  const switchFile = path.join(path.dirname(externalRelayFile("relays")), "switches.json");
  try {
    for (const raw of [JSON.stringify({ v: 1, chat_conversations: false, compact: false }), "{", JSON.stringify({ v: 2, chat_conversations: true })]) {
      fs.writeFileSync(switchFile, raw);
      for (const role of cases) expect(await replay(role)).toEqual(snapshot.surfaces[role]);
    }
    setRelaySwitch("chat_conversations", true);
    for (const role of ["admin", "anonymous_admin", "actions_admin"]) expect(await replay(role)).toEqual(snapshot.surfaces[role]);
  } finally { fs.rmSync(switchFile, { force: true }); }
}, 30000);


for (const scenario of ["answer", "lease_lost", "hard_cap", "invalid_request"] as const)
  test(`owner tier runner: ${scenario}`, async () => {
    const { contextRequest } = await import("./request.fixture");
    const { setRelaySwitch } = await import("./switches");
    const { readConversations } = await import("./conversations");
    const switchFile = path.join(path.dirname(externalRelayFile("relays")), "switches.json");
    const bodies: Record<string, unknown>[] = [], stops: string[] = [], beats: Record<string, unknown>[] = [];
    const id = `owner_${crypto.randomUUID()}`;
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/heartbeat")) {
        beats.push(body as Record<string, unknown>);
        return scenario === "lease_lost" ? { status: 409, body: { error: { code: "lease_lost", message: "gone" } } } : { body: { status: "ok" } };
      }
      return { body: { status: "ok" } };
    });
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0]!.ownerTier = true;
    const request = { ...contextRequest, request_id: id, chat: { key: "owner-group" },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: scenario === "invalid_request" ? "true" : true } } };
    const conversationsBefore = readConversations();
    try {
      setRelaySwitch("chat_conversations", true);
      const completion = await runClaimedRequest(paired, request, undefined, {
        command: "/missing-owner-must-never-run-cli", timeoutMs: scenario === "hard_cap" ? 50 : 2000,
        ownerPorts: {
          launch: async body => { bodies.push(body); return { status: 202, body: { conversationId: "conversation_owner_runner" } }; },
          observe: async () => {
            expect(readRunLedger().runs[0]).toMatchObject({ conversationId: "conversation_owner_runner", childPid: null });
            if (!beats.length || scenario === "lease_lost" || scenario === "hard_cap") return { state: "running" };
            return { state: "ended", finalText: "Owner reply" };
          },
          stop: async (_id, action) => { stops.push(action); }, pollMs: 5,
        },
      });
      expect(readConversations()).toEqual(conversationsBefore);
      expect(readRunLedger().runs).toEqual([]);
      if (scenario === "invalid_request") { expect(completion).toMatchObject({ outcome: "declined", reason: "invalid_request" }); expect(bodies).toEqual([]); }
      else {
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({ cwd: os.homedir(), engine: "codex", model: "gpt-6-sol", effort: "low", accountId: "answer", clientAttemptId: `relay-owner-${id}`, mcpServers: ["viewer"], plugins: [] });
        expect(beats.length).toBeGreaterThan(0);
        expect(beats.every(b => !b.progress)).toBe(true);
        const record = readAnswerRecord(paired.id, "target_1", id);
        expect(record).toMatchObject({ profile: { webSearch: true, owner: true }, conversationId: "conversation_owner_runner" });
        if (scenario === "answer") { expect(completion).toMatchObject({ outcome: "answered", answer: { text: "Owner reply", reply_to: "m1" } }); expect(stops).toEqual([]); }
        if (scenario === "lease_lost") { expect(completion).toBeNull(); expect(stops).toEqual(["interrupt"]); }
        if (scenario === "hard_cap") { expect(completion).toMatchObject({ outcome: "failed", reason: "hard_cap" }); expect(stops).toEqual(["interrupt"]); }
      }
    } finally { fs.rmSync(switchFile, { force: true }); await server.close(); }
  });
