import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AgentRegistry, type StructuredHostClaimDecision, type StructuredTerminationDecisionContext } from "@/lib/agent/registry";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { stopTerminalStructuredOrphan } from "./registry";

const fixture = path.join(import.meta.dir, "fixtures/claudeSuccession.ts");
const key = { engine: "claude" as const, sessionId: "planned-succession" };
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("succession fixture deadline");
    await Bun.sleep(5);
  }
}
async function settled(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
}
function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  return new Promise((resolve, reject) => {
    stream.on("data", chunk => { output += chunk.toString(); });
    stream.once("end", () => resolve(output));
    stream.once("error", reject);
  });
}
async function scenario(run: (s: {
  directory: string; native: ProcessIdentity; child: ProcessIdentity; owner: ChildProcess;
  registry: AgentRegistry; launch: (mode: string) => ChildProcess;
}) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-succession-"));
  const children: ChildProcess[] = [];
  const launch = (mode: string) => {
    const child = spawn(process.execPath, [fixture, mode, directory], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return child;
  };
  let registry: AgentRegistry | undefined;
  let identities: { native: ProcessIdentity; child: ProcessIdentity } | undefined;
  try {
    const owner = launch("owner");
    await until(() => fs.existsSync(path.join(directory, "owner-ready")));
    identities = JSON.parse(fs.readFileSync(path.join(directory, "native.json"), "utf8"));
    registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    await run({ directory, ...identities!, owner, registry, launch });
  } finally {
    const recorded = path.join(directory, "processes.ndjson");
    const owned: ProcessIdentity[] = fs.existsSync(recorded)
      ? fs.readFileSync(recorded, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    for (const identity of owned.reverse()) {
      if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(settled));
    await until(() => owned.every(identity => processIdentityStatus(identity) === "dead"));
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const [caller, recordedCaller] of [["adoption", "claude-adoption"], ["demotion", "startup-demotion"], ["terminal", "terminal-recovery"]]) {
  test(`a terminal Claude orphan stop records the real ${caller} caller and claim refusal`, async () => scenario(async s => {
    const before = s.registry.readOnlySnapshot().entries["claude:planned-succession"]!;
    s.registry.upsert({ ...before, status: "dead" });
    fs.writeFileSync(path.join(s.directory, "exit-owner"), "exit");
    expect(await settled(s.owner)).toBe(0);
    expect(processIdentityStatus(s.native)).toBe("alive");
    expect(processIdentityStatus(s.child)).toBe("alive");
    const successor = s.launch(caller!);
    const output = collect(successor.stdout!);
    const error = collect(successor.stderr!);
    expect(await settled(successor), await error).toBe(0);
    await output;
    const records = fs.readFileSync(path.join(s.directory, "host-termination-journal.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.find(record => record.event === "captured").decision).toEqual({
      caller: recordedCaller, claimRefusal: "live-native", ownerPid: s.owner.pid,
      claimEpoch: 1, writerClaimEpoch: 1, status: "dead",
    });
    expect(records.at(-1).event).toBe("settled");
  }), 20_000);
}

test("planned succession records the live-host adoption refusal and stop decision", async () => scenario(async s => {
  fs.writeFileSync(path.join(s.directory, "exit-owner"), "exit");
  expect(await settled(s.owner)).toBe(0);
  expect(processIdentityStatus(s.native)).toBe("alive");
  expect(processIdentityStatus(s.child)).toBe("alive");
  const before = s.registry.readOnlySnapshot().entries["claude:planned-succession"]!;
  expect(before.status).toBe("live");
  expect(before.structuredHost?.activeTurnRef).toBe("original-turn");
  const successor = s.launch("adoption");
  const output = collect(successor.stdout!);
  const error = collect(successor.stderr!);
  expect(await settled(successor), await error).toBe(0);
  const observed = JSON.parse(await output);
  const records = fs.readFileSync(path.join(s.directory, "host-termination-journal.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(records.find(record => record.event === "captured").decision).toEqual({
    caller: "claude-adoption", claimRefusal: "live-native", ownerPid: s.owner.pid,
    claimEpoch: 1, writerClaimEpoch: 1, status: "live",
  });
  // The retry reaches replacement setup only after the refused first claim.
  // This records the defect; continuity is the pending expectation below.
  expect(observed.optionsCalls).toBe(1);
  expect(records.at(-1).event).toBe("settled");
}), 20_000);

// The agent-state follow-up after #3975 owns the continuity repair. This
// process fixture exercises custody; real broker restoration is also owed there.
test.todo("agent-state follow-up after #3975: planned succession preserves the job and delivers its result once", async () => scenario(async s => {
  fs.writeFileSync(path.join(s.directory, "exit-owner"), "exit");
  expect(await settled(s.owner)).toBe(0);
  const successor = s.launch("adoption");
  const output = collect(successor.stdout!);
  const error = collect(successor.stderr!);
  expect(await settled(successor), await error).toBe(0);
  await output;
  expect(processIdentityStatus(s.native)).toBe("alive");
  expect(processIdentityStatus(s.child)).toBe("alive");
  fs.writeFileSync(path.join(s.directory, "finish-job"), "finish");
  await until(() => fs.existsSync(path.join(s.directory, "agent-results")));
  expect(fs.readFileSync(path.join(s.directory, "starts"), "utf8")).toBe("started\n");
  expect(fs.readFileSync(path.join(s.directory, "completions"), "utf8")).toBe("completed\n");
  expect(fs.readFileSync(path.join(s.directory, "agent-results"), "utf8")).toBe("background-result\n");
}), 20_000);

test("a descendant of a proven-dead Claude host is still stopped with its refusal recorded", async () => scenario(async s => {
  fs.writeFileSync(path.join(s.directory, "exit-owner"), "exit");
  await settled(s.owner);
  process.kill(s.native.pid, "SIGKILL");
  await until(() => processIdentityStatus(s.native) === "dead");
  s.registry.recordStructuredTerminationSurvivors(key, s.native, [s.child]);
  const decision: StructuredHostClaimDecision = { refusal: null };
  expect(s.registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true, decision })).toBeNull();
  expect(decision.refusal).toBe("termination-survivors");
  expect(await stopTerminalStructuredOrphan(s.registry, key, {}, decision)).toBe(true);
  expect(processIdentityStatus(s.child)).toBe("dead");
  const records = fs.readFileSync(path.join(s.directory, "host-termination-journal.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(records.findLast(record => record.event === "captured").decision).toEqual({
    caller: "terminal-recovery", claimRefusal: "termination-survivors", ownerPid: s.owner.pid,
    claimEpoch: 1, writerClaimEpoch: 1, status: "live",
  });
}), 20_000);

test("decision records retain fixed fields and discard unexpected text", async () => scenario(async s => {
  const unexpected = "untrusted decision payload";
  const decision = { caller: unexpected, claimRefusal: unexpected, payload: unexpected } as unknown as StructuredTerminationDecisionContext;
  expect(s.registry.captureStructuredTerminationSurvivors(key, s.native, [s.child], "decision-test", decision)).not.toBeNull();
  const line = fs.readFileSync(path.join(s.directory, "host-termination-journal.ndjson"), "utf8").trim();
  expect(line).not.toContain(unexpected);
  expect(JSON.parse(line).decision).toEqual({ caller: null, claimRefusal: null, ownerPid: s.owner.pid,
    claimEpoch: 1, writerClaimEpoch: 1, status: "live" });
}), 20_000);

test("a reused claim decision clears its earlier refusal when a claim succeeds", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claim-decision-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const decision: StructuredHostClaimDecision = { refusal: null };
  const owner = captureProcessIdentity(process.pid);
  try {
    expect(registry.claimStructuredHost(key, owner, { decision })).toBeNull();
    expect(decision.refusal).toBe("missing-entry");
    registry.upsert({ key, artifactPath: path.join(directory, "session.jsonl"), cwd: directory, accountId: null,
      status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
      structuredHost: { kind: "claude-broker", endpoint: "stdio:released", process: null,
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
    expect(registry.claimStructuredHost(key, owner, { decision })).not.toBeNull();
    expect(decision.refusal).toBeNull();
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
