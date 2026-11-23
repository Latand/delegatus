import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { buildManifest, descriptorDigest, digest, physical, readEnvelope, writeEnvelope, identitySchema, type ProducerReport } from "./wire";
import { RecordedCheckStore, rowSchema, type CheckRow } from "./store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture(sharedLaunch: boolean, terminalOwner?: "command" | "supervisor" | "producer-command" | "producer-supervisor") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorded-capacity-")); roots.push(root);
  fs.writeFileSync(path.join(root, "source.ts"), "export const fixture = true;\n");
  const manifest = await buildManifest({ cwd: root, deadline: 1_900_000_000_000, executionMs: 1000,
    executionEnvironment: {}, selection: ["capacity.test.ts"], configurationDigest: digest({ fixture: true }),
    roots: [{ directory: root, purpose: "evidence" }], inputs: [{ root, file: "source.ts" }],
    outputs: [{ root, file: "output" }], completion: { root, file: "complete.json" } });
  const owner = identitySchema.parse(captureProcessIdentity(process.pid));
  const body = { version: 1 as const, runId: digest("next-run"), manifest, argv: ["fixture"], recorder: owner,
    directoryIdentity: physical(root), startedAt: 1_790_000_000_000,
    startedUptimeMs: 1, deadlineUptimeMs: manifest.deadlineUptimeMs };
  const row = rowSchema.parse({ id: body.runId, request: digest("next-request"), binding: {
    project: "fixture", pipeline: "capacity-lane", stage: "build", attempt: 1, launch: "one-launch",
    conversation: "fixture-conversation", session: "fixture-session", runtimeFence: "fixture-fence", endpoint: "fixture", host: owner,
  }, log: path.join(root, "check.log"), descriptor: { ...body, wrapper: owner, descriptorDigest: descriptorDigest(body) },
    revision: 1, admission: "accepted", reason: "native fixture", result: null, notification: null, acknowledgement: null });
  const filename = path.join(root, "state.sqlite"), input = path.join(root, "input.json"), output = path.join(root, "ready.json");
  writeEnvelope(input, { filename, output, row, count: sharedLaunch ? 4 : 128, sharedLaunch, terminalOwner });
  const child = spawn(process.execPath, [path.resolve("src/lib/recordedChecks/capacity.process.fixture.ts"), input],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  try {
    const exit = once(child, "exit");
    const [code] = await exit;
    expect(code, errors).toBe(0);
  } finally { await stopFixtureProcess(child); }
  return { root, filename, row, owner: (readEnvelope(output) as { owner: typeof owner }).owner };
}

for (const sharedLaunch of [true, false]) test(`abandoned ${sharedLaunch ? "launch" : "global"} holders release capacity across process restart while a live holder stays`, async () => {
  const f = await fixture(sharedLaunch);
  const liveId = digest(["capacity-holder", 0]);
  let store = new RecordedCheckStore(f.filename);
  const before = store.get(liveId)!;
  expect(store.rootHeld(f.root)).toBeTrue();
  await store.write(f.row, null);
  expect(store.get(f.row.id)?.admission).toBe("accepted");
  expect(store.forHost(f.row.binding.conversation)).toHaveLength((sharedLaunch ? 4 : 128) + 1);
  if (sharedLaunch) expect(store.forLaunch(f.row.binding.launch)).toHaveLength(5);
  expect(store.get(liveId)).toEqual(before);
  const holders = store.capacity();
  expect(holders.map(row => row.id).sort()).toEqual([liveId, f.row.id].sort());
  expect(holders.every(row => row.state === "live-or-unverified")).toBeTrue();
  // Capacity release preserves every receipt, replay key and evidence hold.
  const abandoned = store.get(digest(["capacity-holder", 1]))!;
  expect(store.byRequest(abandoned.request)).toEqual(abandoned);
  expect(abandoned.acknowledgement).toBeNull();
  expect(store.rootHeld(f.root)).toBeTrue();
  store.close(); store = new RecordedCheckStore(f.filename);
  try {
    expect(store.capacity()).toEqual(holders);
    expect(store.get(liveId)).toEqual(before);
    expect(store.byRequest(abandoned.request)).toEqual(abandoned);
    const db = new Database(f.filename, { readonly: true });
    try {
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM recorded_checks").get()!.count).toBe((sharedLaunch ? 4 : 128) + 1);
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM recorded_check_roots WHERE held=1").get()!.count).toBe((sharedLaunch ? 4 : 128) + 1);
    } finally { db.close(); }
  } finally { store.close(); }
});

test("legacy slot seeding is atomic and reopening never reacquires released custody", async () => {
  const f = await fixture(true);
  const db = new Database(f.filename);
  db.exec("DROP TABLE recorded_check_slots"); db.close();
  let store = new RecordedCheckStore(f.filename);
  expect(store.capacity()).toHaveLength(4);
  await store.write(f.row, null);
  const abandoned = store.get(digest(["capacity-holder", 1]))!;
  store.close(); store = new RecordedCheckStore(f.filename);
  try {
    await store.write({ ...abandoned, revision: abandoned.revision + 1, reason: "retained failure remains readable" }, abandoned.revision);
    expect(store.capacity()).toHaveLength(2);
    expect(store.rootHeld(f.root)).toBeTrue();
  } finally { store.close(); }
});

test("unverified native identity retains every slot until kernel proof recovers", async () => {
  const f = await fixture(true), store = new RecordedCheckStore(f.filename);
  const alive = procBackend.pidAlive, identity = procBackend.processIdentity;
  const aliveProbe = spyOn(procBackend, "pidAlive").mockImplementation(pid => pid === f.owner.pid || alive(pid));
  const identityProbe = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === f.owner.pid ? null : identity(pid));
  try {
    await expect(store.write(f.row, null)).rejects.toThrow("custody capacity is full");
    expect(store.get(f.row.id)).toBeNull();
    expect(store.capacity()).toHaveLength(4);
    expect(store.capacity().every(holder => holder.state === "live-or-unverified")).toBeTrue();
  } finally { identityProbe.mockRestore(); aliveProbe.mockRestore(); }
  try {
    await store.write(f.row, null);
    expect(store.capacity()).toHaveLength(2);
    expect(store.rootHeld(f.root)).toBeTrue();
  } finally { store.close(); }
});

function unknownClose(row: CheckRow, supervisor: ProducerReport["supervisor"], command: ProducerReport["command"]) {
  const report: ProducerReport = { version: 1, runId: row.id, descriptorDigest: row.descriptor.descriptorDigest,
    supervisor, command, kind: "portable", boundary: "direct", cancellation: null, service: null,
    commandExit: null, commandSignal: null, cleanup: "unknown", phase: "close", at: 1_790_000_000_001, atUptimeMs: 2 };
  return { state: "terminal" as const, reason: "owned command cleanup remains unknown",
    terminal: { version: 1 as const, runId: row.id, descriptorDigest: row.descriptor.descriptorDigest,
      wrapperExit: 1, wrapperSignal: null, cancellation: null, closedAt: 1_790_000_000_002,
      closedUptimeMs: 3, report, reports: [report], dispatch: "started" as const },
    complete: false, visited: 0, completed: 0, failed: 0, evidence: [], evidenceDigest: digest([]),
    evidenceCount: 0, revision: 1, digest: digest(["unknown-close", row.id]), history: [] };
}

test("review regression: persisted unknown close keeps its live terminal command capacity", async () => {
  const f = await fixture(true);
  let store = new RecordedCheckStore(f.filename);
  try {
    for (let index = 1; index < 4; index++) {
      const held = store.get(digest(["capacity-holder", index]))!;
      await store.write({ ...held, revision: held.revision + 1,
        result: unknownClose(held, f.owner, f.row.binding.host) }, held.revision);
      const retained = store.get(held.id)!;
      expect(retained.result!.terminal!.report!.command).toEqual(f.row.binding.host);
      expect(retained.result!.terminal!.reports).toEqual([]);
    }
    store.close(); store = new RecordedCheckStore(f.filename);
    // One live host and three live commands still own all four slots.
    await expect(store.write(f.row, null)).rejects.toThrow("custody capacity is full");
    expect(store.get(f.row.id)).toBeNull();
    expect(store.capacity()).toHaveLength(4);
    expect(store.capacity().every(holder => holder.state === "live-or-unverified")).toBeTrue();
  } finally { store.close(); }
});

for (const sharedLaunch of [true, false])
for (const source of ["command", "supervisor", "producer-command", "producer-supervisor"] as const)
test(`persisted ${source} retains every ${sharedLaunch ? "launch" : "global"} slot after its writer exits`, async () => {
  const f = await fixture(sharedLaunch, source), count = sharedLaunch ? 4 : 128;
  let store = new RecordedCheckStore(f.filename);
  const live = f.row.binding.host;
  try {
    for (const holder of store.capacity()) {
      const retained = store.get(holder.id)!;
      expect(retained.custody).toEqual([]);
      expect(retained.result!.terminal!.reports).toEqual([]);
      expect(retained.terminalOwners).toContainEqual(live);
      // Legacy rows lack the compact owners. Their aggregate report is still
      // authoritative; only producer-only cases need the new retained list.
      if (!source.startsWith("producer-")) {
        const { terminalOwners: _owners, ...legacy } = retained;
        await store.write({ ...legacy, revision: legacy.revision + 1 }, legacy.revision);
      }
    }
    store.close(); store = new RecordedCheckStore(f.filename);
    await expect(store.write(f.row, null)).rejects.toThrow("custody capacity is full");
    expect(store.capacity()).toHaveLength(count);
    expect(store.capacity().every(holder => holder.state === "live-or-unverified")).toBeTrue();
    expect(store.get(f.row.id)).toBeNull();

    const nativeIdentity = procBackend.processIdentity;
    const identityProbe = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === live.pid ? null : nativeIdentity(pid));
    try {
      store.close(); store = new RecordedCheckStore(f.filename);
      await expect(store.write(f.row, null)).rejects.toThrow("custody capacity is full");
      expect(store.capacity()).toHaveLength(count);
      expect(store.capacity().every(holder => holder.state === "live-or-unverified")).toBeTrue();
    } finally { identityProbe.mockRestore(); }

    // Only the identity probe changes: proof of the old identity's death frees
    // every slot. The replacement process remains a live, admitted owner.
    const deadIdentity = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === live.pid ? `${live.startIdentity}-replacement` : nativeIdentity(pid));
    try {
      const replacement = { ...live, startIdentity: `${live.startIdentity}-replacement` };
      const { wrapper: _wrapper, descriptorDigest: _hash, ...body } = f.row.descriptor;
      const descriptor = { ...body, recorder: replacement };
      await store.write({ ...f.row, binding: { ...f.row.binding, host: replacement },
        descriptor: { ...descriptor, wrapper: replacement, descriptorDigest: descriptorDigest(descriptor) } }, null);
      expect(store.capacity().map(holder => holder.id)).toEqual([f.row.id]);
      expect(store.rootHeld(f.root)).toBeTrue();
      expect(store.get(digest(["capacity-holder", 0]))?.acknowledgement).toBeNull();
    } finally { deadIdentity.mockRestore(); }
  } finally { store.close(); }
});
