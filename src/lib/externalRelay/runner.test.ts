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
import { listAnswerRecords, readAnswerRecord, settleInterruptedAnswer } from "./answers";
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
  const completions: any[] = [];
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
  const beats: any[] = [];
  const completed: any[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats.push(body);
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
    expect(beats[1].progress.label).toBe("Checking notes");
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
  const completions: any[] = [];
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
  const completions: any[] = [];
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
  const completions: any[] = [];
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
  const completions: any[] = [];
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
  const completions: any[] = [];
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
  const beats: any[] = [];
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats.push(body);
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
  const completions: any[] = [];
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
    expect(completions.map((body) => [body.outcome, body.reason])).toEqual([
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
    const completions: any[] = [];
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
  const completions: any[] = [];
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
    expect(claimBody).toEqual({ wait_s: 25, kinds: ["answer"], features: ["requester_context"], slots: [{ target_id: "t_target", free: 1 }] });
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
