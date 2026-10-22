import { loopProgressProbe } from "@/lib/agent/registryLockHolderFixture";
import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dropRun,
  mergeRelayTargets,
  reserveRun,
  reserveRunAsync,
  claimRelayRequestAsync,
  settleRelayRequestClaimAsync,
  withFileLock,
  withFileLockAsync,
  readRunLedger,
  readRelayStore,
  updateRelayStore,
} from "./store";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-test-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
test("retained completed and confirmed stop rows do not consume admission capacity", async () => {
  const row = { requestId: "capacity-completed", leaseId: "fixture", relayId: "capacity-fixture", targetId: "fixture",
    childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: null, runDir: "", startedAt: "2026-01-01T00:00:00.000Z" };
  try {
    expect(reserveRun({ ...row, capacityReleased: true })).toBe("added");
    expect(reserveRun({ ...row, requestId: "capacity-stopped", ownerTurn: { clientAttemptId: "fixture", cancel: "interrupt", confirmed: true } })).toBe("added");
    expect(reserveRun({ ...row, requestId: "capacity-next" }, 1)).toBe("added");
    dropRun("capacity-next");
    expect(await reserveRunAsync({ ...row, requestId: "capacity-next" }, 1, Date.now() + 5000)).toBe("added");
    expect(await reserveRunAsync({ ...row, requestId: "capacity-overflow" }, 1, Date.now() + 5000)).toBe("full");
    dropRun("capacity-next");
    const child = Bun.spawn([process.execPath, "-e", `
      import { reserveRunAsync } from "./src/lib/externalRelay/store";
      console.log(await reserveRunAsync(${JSON.stringify({ ...row, requestId: "capacity-next" })}, 1, Date.now() + 5000));
    `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ output: output.trim(), error, code }).toEqual({ output: "added", error: "", code: 0 });
  } finally { for (const id of ["capacity-completed", "capacity-stopped", "capacity-next", "capacity-overflow"]) dropRun(id); }
});
test("ledger records a request once and removes it", () => {
  const row = {
    requestId: "r1",
    leaseId: "lease1",
    relayId: "relay1",
    targetId: "target1",
    childPid: null,
    childIdentity: null,
    ownerPid: process.pid,
    ownerIdentity: "identity",
    runDir: root,
    startedAt: new Date().toISOString(),
  };
  expect(reserveRun(row)).toBe("added");
  expect(reserveRun(row)).toBe("duplicate");
  expect(readRunLedger().runs).toHaveLength(1);
  dropRun(row.requestId);
  expect(readRunLedger().runs).toHaveLength(0);
  expect(
    fs.statSync(path.join(root, "external-relay", "runs.json")).mode & 0o777,
  ).toBe(0o600);
});
test("store mints one install ID and writes a private file", () => {
  const first = readRelayStore();
  updateRelayStore((store) => store);
  expect(readRelayStore().installId).toBe(first.installId);
  expect(fs.statSync(path.join(root, "external-relay")).mode & 0o777).toBe(
    0o700,
  );
});
test("two Viewer processes cannot reserve the same target slot", async () => {
  const childFile = path.join(root, "reserve-child.ts");
  const modulePath = path.join(process.cwd(), "src/lib/externalRelay/store.ts");
  fs.writeFileSync(
    childFile,
    `import { reserveRun } from ${JSON.stringify(modulePath)};\nconst id = process.env.RELAY_TEST_ID!;\nconsole.log(reserveRun({ requestId: id, leaseId: id, relayId: "shared", targetId: "target", childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: "child", runDir: "", startedAt: new Date().toISOString() }, 1));\n`,
  );
  const children = ["first", "second"].map((id) =>
    Bun.spawn([process.execPath, childFile], {
      env: { ...process.env, LLV_STATE_DIR: root, RELAY_TEST_ID: id },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outputs = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      text: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    })),
  );
  expect(outputs.map((item) => item.code)).toEqual([0, 0]);
  expect(outputs.map((item) => item.text.trim()).sort()).toEqual([
    "added",
    "full",
  ]);
  expect(
    readRunLedger().runs.filter((run) => run.relayId === "shared"),
  ).toHaveLength(1);
  for (const run of readRunLedger().runs.filter(
    (item) => item.relayId === "shared",
  ))
    dropRun(run.requestId);
});

test("separate processes share a request claim that survives execution-row cleanup", async () => {
  const childFile = path.join(root, "claim-child.ts");
  const modulePath = path.join(process.cwd(), "src/lib/externalRelay/store.ts");
  const procPath = path.join(process.cwd(), "src/lib/proc/index.ts");
  fs.writeFileSync(childFile, `import { claimRelayRequestAsync } from ${JSON.stringify(modulePath)};
import { procBackend } from ${JSON.stringify(procPath)};
const result = await claimRelayRequestAsync("cross-process-request", process.env.RELAY_LEASE!, Date.now() + 5000);
console.log(JSON.stringify({ result, pid: process.pid, identity: procBackend.processIdentity(process.pid) }));
await Bun.sleep(1000);
`);
  const launch = (lease: string) => Bun.spawn([process.execPath, childFile], {
    env: { ...process.env, LLV_STATE_DIR: root, RELAY_LEASE: lease }, stdout: "pipe", stderr: "pipe",
  });
  const first = launch("same-lease"), second = launch("same-lease");
  const read = async (child: ReturnType<typeof launch>) => {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as { result: { kind: string; completion?: unknown }; pid: number; identity: string };
  };
  const initial = await Promise.all([read(first), read(second)]);
  expect(initial.map(item => item.result.kind).sort()).toEqual(["claimed", "duplicate"]);
  const owner = initial.find(item => item.result.kind === "claimed")!;
  const completion = { lease_id: "same-lease", outcome: "declined" as const, reason: "busy", detail: null, retry_after_s: null };
  await settleRelayRequestClaimAsync("cross-process-request", "same-lease", owner.pid, owner.identity, "terminal", completion, Date.now() + 5000);
  const requestRow = { requestId: "cross-process-request", leaseId: "same-lease", relayId: "shared", targetId: "target",
    childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: "test", runDir: root, startedAt: new Date().toISOString() };
  expect(reserveRun(requestRow)).toBe("added");
  dropRun(requestRow.requestId);
  const retry = await read(launch("same-lease"));
  expect(retry.result).toEqual({ kind: "terminal", completion });
});
test("concurrent relay settings updates retain both changes", async () => {
  const childFile = path.join(root, "update-child.ts");
  const modulePath = path.join(process.cwd(), "src/lib/externalRelay/store.ts");
  fs.writeFileSync(childFile, `import { updateRelayStore } from ${JSON.stringify(modulePath)};
updateRelayStore((store) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return { ...store, pending: [...store.pending, {
    id: process.env.RELAY_TEST_ID!, origin: "https://example.test",
    api_base: "https://example.test/v1", name: "Test", description: "",
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    pairing_id: "pair", poll_secret: "x".repeat(43), code: "1234-5678",
    verify_url: null, expires_at: new Date(Date.now() + 600_000).toISOString(), poll_interval_s: 2,
  }] };
});
`);
  const children = ["update_a", "update_b"].map((id) =>
    Bun.spawn([process.execPath, childFile], {
      env: { ...process.env, LLV_STATE_DIR: root, RELAY_TEST_ID: id },
      stdout: "pipe", stderr: "pipe",
    }),
  );
  const outputs = await Promise.all(children.map(async (child) => ({
    code: await child.exited,
    error: await new Response(child.stderr).text(),
  })));
  expect(outputs.map((item) => item.code)).toEqual([0, 0]);
  expect(readRelayStore().pending.map((item) => item.id).sort()).toEqual([
    "update_a", "update_b",
  ]);
});
test("a pending pairing past its expiry leaves relays.json with its poll secret on the next read", () => {
  const file = path.join(root, "external-relay", "relays.json");
  const entry = (id: string, expiresAt: number) => ({
    id, origin: `https://${id}.example`, api_base: `https://${id}.example/v1`,
    name: "Test", description: "",
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    pairing_id: id, poll_secret: `${id}-poll`, code: "1234-5678",
    verify_url: null, expires_at: new Date(expiresAt).toISOString(), poll_interval_s: 2,
  });
  // Written straight to the file, as a pairing left behind by an earlier
  // process would be; no check ever reaches the service for it.
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...stored, pending: [
    entry("lapsed", Date.now() - 1_000), entry("live", Date.now() + 600_000),
  ] }));
  expect(readRelayStore().pending.map((item) => item.id)).toEqual(["live"]);
  const text = fs.readFileSync(file, "utf8");
  expect(text).not.toContain("lapsed-poll");
  expect(text).toContain("live-poll");
});
test("a target refresh keeps settings of listed targets, adds new ones unconfigured and drops the rest", () => {
  const stored = [
    {
      id: "kept", name: "Old name", answered_by: "install" as const,
      fallback: "service" as const, enabled: false, engine: "codex" as const,
      model: "gpt-6-sol", effort: "low", project: "repo-x", concurrency: 3,
      hardCapMinutes: 12,
    },
    {
      id: "gone", name: "Gone", answered_by: "install" as const,
      fallback: "service" as const, enabled: true, engine: "claude" as const,
      model: "claude-sonnet-5", effort: null, project: null, concurrency: 1,
      hardCapMinutes: 30,
    },
  ];
  const merged = mergeRelayTargets(stored, [
    { target_id: "added", name: "Added", answered_by: "install", fallback: "none" },
    { target_id: "kept", name: "New name", answered_by: "service", fallback: "none" },
  ]);
  expect(merged).toEqual([
    {
      id: "added", name: "Added", answered_by: "install", fallback: "none",
      enabled: true, engine: null, model: null, effort: null, project: null,
      concurrency: 1, hardCapMinutes: 30,
    },
    {
      ...stored[0]!, name: "New name", answered_by: "service", fallback: "none",
    },
  ]);
  expect(mergeRelayTargets(stored, [])).toEqual([]);
});

test("store contention yields to short timers while waiting for the same live lock", async () => {
  const lock = path.join(root, "external-relay/runs.json.lock");
  const ready = path.join(root, "contention-ready");
  const go = path.join(root, "contention-go");
  const childFile = path.join(root, "contention-child.ts");
  fs.writeFileSync(childFile, `import fs from "node:fs";
import { procBackend } from ${JSON.stringify(path.join(process.cwd(), "src/lib/proc/index.ts"))};
fs.mkdirSync(${JSON.stringify(path.dirname(lock))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
while (!fs.existsSync(${JSON.stringify(go)})) await Bun.sleep(1);
fs.rmSync(${JSON.stringify(lock)});
`);
  const child = Bun.spawn([process.execPath, childFile], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const probe = loopProgressProbe();
  try {
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await Bun.sleep(5);
    expect(fs.existsSync(ready)).toBe(true);
    const row = { requestId: "contended", leaseId: "lease", relayId: "contention", targetId: "target", childPid: null,
      childIdentity: null, ownerPid: process.pid, ownerIdentity: "fixture", runDir: root, startedAt: new Date().toISOString() };
    probe.arm(() => { fs.writeFileSync(go, "release"); });
    expect(await probe.run(() => reserveRunAsync(row, 1, Date.now() + 5000))).toBe("added");
    expect(await child.exited).toBe(0);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; dropRun("contended"); }
}, 10000);

test("a contended store lock that frees at the cutoff cannot commit expired waiting work", async () => {
  let now = 1000, writes = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const file = path.join(root, "deadline-lock.json");
  let pending!: Promise<string>;
  try {
    withFileLock(file, () => {
      pending = withFileLockAsync(file, () => { writes++; return "committed"; }, 1010);
      now = 1010;
    });
    await expect(pending).rejects.toThrow("relay store is busy");
    expect(writes).toBe(0);
  } finally { await pending.catch(() => {}); clock.mockRestore(); }
});

test("an asynchronous file-lock action retains ownership until its work finishes", async () => {
  const file = path.join(root, "async-action-lock.json");
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = withFileLockAsync(file, async () => { entered(); await held; return "committed"; }, Date.now() + 5000);
  try {
    await inside;
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    release();
    await expect(pending).resolves.toBe("committed");
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  } finally { release(); await pending.catch(() => {}); }
});
