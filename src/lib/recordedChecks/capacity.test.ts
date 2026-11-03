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
import { buildManifest, descriptorDigest, digest, physical, readEnvelope, writeEnvelope, identitySchema } from "./wire";
import { RecordedCheckStore, rowSchema } from "./store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture(sharedLaunch: boolean) {
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
  writeEnvelope(input, { filename, output, row, count: sharedLaunch ? 4 : 128, sharedLaunch });
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
