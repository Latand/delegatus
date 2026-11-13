import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { determined } from "@/lib/runtime/determinable";
import { runStructuredHostRetirementSweep } from "@/lib/runtime/structuredHostRetirement";
import { AgentStateService } from "./service";
import { readAgentStateMetrics, readAgentProjection, subjectId } from "./store";
import { FIXTURE_NOW, FIXTURE_SESSION, FIXTURE_CONVERSATION, fixtureRegistry, fixtureRecords, type FixtureEngine } from "./testFixture";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "@/lib/runtime/eventStore";
import { claudeHostColumns } from "@/lib/runtime/registry";

const [role, root, engineValue, pidValue, portValue] = process.argv.slice(2);
const engine = engineValue as FixtureEngine;
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = readline.createInterface({ input: process.stdin });
if (role === "native") {
  const records = fixtureRecords(engine);
  const append = (rows: unknown[]) => fs.appendFileSync(path.join(root!, "native.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  let starts = 0;
  const server = net.createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", () => { starts++; append(records.open); socket.write("started\n"); });
  });
  server.listen(0, "127.0.0.1", () => output({ port: (server.address() as net.AddressInfo).port }));
  input.on("line", line => {
    if (line === "end") { append(records.close); output({ ended: true, starts }); }
  });
} else if (role === "broker-owner") {
  const host = await ClaudeStreamBrokerHost.start({ cwd: root!, sessionId: FIXTURE_SESSION,
    eventStore: new FileRuntimeEventStore(), deliveryLedger: new FileClaudeDeliveryLedger(path.join(root!, "deliveries")),
    readTranscript: () => [], readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    spawnProcess: (_command, _args, options) => spawn(process.execPath,
      [path.join(import.meta.dir, "../runtime/fixtures/claudeBackgroundSuccessionChild.ts"), root!, FIXTURE_SESSION, "anchor"],
      { ...options, stdio: ["pipe", "pipe", "pipe"], detached: true }),
  });
  const events = host.attach(0)[Symbol.asyncIterator]();
  await host.send({ id: "local-prompt-ref", text: "fixture work" });
  for (;;) {
    const next = await events.next();
    if (next.done) throw new Error("broker ended before the tool output");
    if (next.value.kind === "item" && (next.value.item as Record<string, unknown>)?.uuid === "native-tool-output") break;
  }
  await events.return?.();
  const health = await host.health();
  const native = captureProcessIdentity(health.pid!);
  const registry = new AgentRegistry(path.join(root!, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const initial = fixtureRegistry(root!, "claude", native, captureProcessIdentity(process.pid));
  initial.entries[`claude:${FIXTURE_SESSION}`]!.structuredHost = claudeHostColumns(health, 1);
  await registry.deliveryWriteOrBusy({ label: "fixture.broker-owner-checkpoint" }, () => registry.agentStateWrite(rows => Object.assign(rows, initial)));
  output({ ready: true, native });
} else if (role === "owner") {
  const registry = new AgentRegistry(path.join(root!, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const initial = fixtureRegistry(root!, engine, captureProcessIdentity(Number(pidValue)), captureProcessIdentity(process.pid));
  const socket = net.connect({ host: "127.0.0.1", port: Number(portValue) }, () => socket.write("start\n"));
  socket.on("error", () => {});
  socket.once("data", async () => {
    await registry.deliveryWriteOrBusy({ label: "fixture.owner-checkpoint" }, () => registry.agentStateWrite(file => {
      Object.assign(file, initial);
    }));
    output({ ready: true, owner: captureProcessIdentity(process.pid) });
  });
} else {
  const registry = new AgentRegistry(path.join(root!, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  let now = FIXTURE_NOW + 2000;
  let tick: () => void = () => { throw new Error("scheduler has not armed"); };
  let publications = 0;
  let protectedDelivery: string | null = null;
  const service = new AgentStateService({ registry, now: () => now, owns: () => true, process: processIdentityStatus,
    memory: () => null, release: "fixture-successor", publish: async () => { publications++; return role !== "successor-unpublished"; } });
  service.start(((callback: () => void) => { tick = callback; return setInterval(() => {}, 60_000); }) as typeof setInterval);
  await service.request();
  const state = () => {
    const entry = registry.hostEntry({ engine, sessionId: FIXTURE_SESSION })!;
    output({ entry, projection: readAgentProjection(registry, subjectId(entry)), metrics: readAgentStateMetrics(registry), publications });
  };
  state();
  for await (const line of input) {
    if (line === "cycle") { tick(); await service.request(); state(); }
    else if (line === "retire" || line === "recent" || line === "protect") {
      now = line !== "recent" ? FIXTURE_NOW + 7 * 3_600_000 : FIXTURE_NOW + 2000;
      if (line !== "recent") fs.utimesSync(path.join(root!, "native.jsonl"), new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
      if (line === "protect") protectedDelivery = (await registry.deliveryWriteOrBusy({ label: "fixture.accept-delivery" }, () =>
        registry.holdDelivery(FIXTURE_CONVERSATION, "fixture accepted work", "fixture-protected-message"))).id;
      if (line === "retire" && protectedDelivery) await registry.deliveryWriteOrBusy({ label: "fixture.settle-delivery" }, () =>
        registry.terminalizeHeldDelivery(protectedDelivery!, "fixture operation settled"));
      tick(); await service.request();
      const report = await runStructuredHostRetirementSweep({ snapshot: () => registry.readOnlySnapshot(), publicationState: () => "ready",
        handoffRows: () => determined([]), durableEventTail: () => determined(0), realtimeBound: () => determined(false),
        orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
        readCursor: () => null, writeCursor: () => {}, record: () => {}, now: () => now, graceMs: 100, treePss: () => ({ bytes: null, measuredProcesses: 0 }) });
      const entry = registry.hostEntry({ engine, sessionId: FIXTURE_SESSION })!;
      output({ report, projection: readAgentProjection(registry, subjectId(entry)) });
    }
  }
  service.stop(); registry.close();
}
