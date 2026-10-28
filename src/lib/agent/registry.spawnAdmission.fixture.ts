import { spyOn } from "bun:test";
import path from "node:path";
import { AgentRegistry } from "./registry";
import { productionLaunchMembershipPorts } from "@/lib/tasks/launchMembership";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";

// The parent enforces the real execution bound. Only this child changes its
// monotonic clock, and the separate writer stays held until a failed probe.
const mode = process.argv[2]!;
resetBlockingWaitsForTests(() => {});
let clock = 1_000;
Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "admission-fixture.json"), undefined, undefined,
  { sqliteMode: "sqlite", ...(mode === "old-budget" ? { sqliteWriterDeadlineMs: 2_000 } : {}) });
const filename = registry.filename;
let writer: ReturnType<typeof Bun.spawn> | undefined;
let release: Promise<unknown> | undefined;
let releaseQueue: (() => void) | undefined;
if (mode === "queue-cutoff") {
  (registry as unknown as { writerAdmissionTail: Promise<void> }).writerAdmissionTail = new Promise(resolve => { releaseQueue = resolve; });
}
let failedProbes = 0;
const requestedWaits: number[] = [];
const write = registry.accountMutationWrite.bind(registry);
const probe = registry.deliveryWriteNow.bind(registry);
const commit = spyOn(productionLaunchMembershipPorts, "commit").mockImplementation(() => {
  if (mode === "membership-cutoff") clock += 3_000;
  return { ok: true, tasks: [], taskIds: ["fixture-task"], created: [], changed: false };
});
const admission = spyOn(registry, "accountMutationWrite").mockImplementation(async <T>(label: string, operation: () => T, guard?: () => void,
  options?: Parameters<AgentRegistry["accountMutationWrite"]>[3]) => {
  requestedWaits.push(options?.waitMs ?? -1);
  if (label === "spawn membership record" && mode !== "membership-cutoff") {
    writer = Bun.spawn([process.execPath, "-e", `
      const { Database } = await import("bun:sqlite");
      const db = new Database(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("held\\n");
      for await (const _ of Bun.stdin.stream()) break;
      db.exec("ROLLBACK");
      db.close();
    `, filename.replace(/\.json$/, ".sqlite")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = (writer.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      const held = await reader.read();
      if (!new TextDecoder().decode(held.value).includes("held")) throw Error("writer did not acquire");
    } finally { reader.releaseLock(); }
  }
  const result = await write(label, operation, guard, options);
  // Admission has refused at the cutoff. Release the fixture writer before
  // custody cleanup, whose asynchronous writer does not use deliveryWriteNow.
  if (!result.acquired && mode === "cutoff" && writer && !release) {
    const child = writer;
    const stdin = child.stdin as import("bun").FileSink;
    stdin.write("release\n");
    stdin.end();
    release = child.exited.then(code => { if (code !== 0) throw Error(`writer exited with ${code}`); });
    await release;
  }
  return result;
});
const delivery = spyOn(registry, "deliveryWriteNow").mockImplementation(<T>(correlation: Parameters<AgentRegistry["deliveryWriteNow"]>[0], operation: () => T,
  options?: Parameters<AgentRegistry["deliveryWriteNow"]>[2]) => {
  const result = probe(correlation, operation, options);
  if (!result.acquired && !failedProbes++) {
    // Crossing the former budget is observed, never inferred from a timer.
    clock += mode === "cutoff" || mode === "released-at-cutoff" ? 3_000 : 2_100;
    if (mode !== "cutoff") {
      const child = writer!;
      const stdin = child.stdin as import("bun").FileSink;
      stdin.write("release\n");
      stdin.end();
      release = child.exited.then(code => { if (code !== 0) throw Error(`writer exited with ${code}`); });
    }
  }
  return result;
});
try {
  let result: string;
  try {
    const work = registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured",
      clientAttemptId: "contended-membership", launchProfile: { title: "Writer admission" } }, undefined,
      mode.endsWith("cutoff") ? { deadline: clock + 3_000 } : {});
    if (releaseQueue) { clock += 3_000; releaseQueue(); }
    result = (await work).kind;
  } catch (error) { result = error instanceof Error ? error.message : String(error); }
  await release;
  // A new connection must acquire immediately after successful admission.
  const { Database } = await import("bun:sqlite");
  let unlocked = false;
  if (mode !== "cutoff") {
    const peer = new Database(filename.replace(/\.json$/, ".sqlite"));
    try { peer.exec("BEGIN IMMEDIATE"); peer.exec("ROLLBACK"); unlocked = true; }
    finally { peer.close(); }
  }
  const receipt = registry.spawnReceiptForClientAttempt("contended-membership");
  process.stdout.write(JSON.stringify({ result, failedProbes, requestedWaits, elapsed: clock - 1_000,
    membershipAdmitted: receipt?.membershipAdmitted === true, unlocked,
    wait: blockingWaitDiagnostics().sites["registry-lock-async"] }));
} finally {
  if (writer?.exitCode === null) writer.kill("SIGKILL");
  await writer?.exited;
  commit.mockRestore(); admission.mockRestore(); delivery.mockRestore(); registry.close();
}
