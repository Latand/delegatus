import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { advertisedSlots, runClaimedRequest, runningCount } from "./runner";
import { readRunLedger, type PairedRelay } from "./store";
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
