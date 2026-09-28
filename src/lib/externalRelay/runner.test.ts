import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { advertisedSlots, runClaimedRequest, runningCount } from "./runner";
import { readRunLedger, updateRelayStore, type PairedRelay } from "./store";
import { confirmRelayPairing } from "./pairing";
import { sampleRequest } from "./protocol.test";
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
