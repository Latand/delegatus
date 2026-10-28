import fs from "node:fs";
import path from "node:path";
import { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { determined } from "./determinable";
import { codexHostColumns } from "./registry";
import { runStructuredHostRetirementSweep, type StructuredHostRetirementDependencies } from "./structuredHostRetirement";
import { projectRetirementStatus } from "./structuredHostRetirementStatus";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const session = (index: number) => ["00000000", "0000", "0000", "0000", String(index).padStart(12, "0")].join("-");
const filename = statePath("fixture-registry.json");
const scenario = process.argv[2]!;
const gone = scenario.startsWith("gone");
if (!fs.existsSync(filename)) {
  const entries: Record<string, unknown> = {};
  const conversations: Record<string, unknown> = {};
  const count = scenario === "paging" ? 524 : 6;
  for (let index = 1; index <= count; index++) {
    const id = session(index);
    const key = `codex:${id}`;
    const pathname = path.join(path.dirname(filename), `${id}.jsonl`);
    const columns = codexHostColumns({
      status: "idle", sessionKey: key, endpoint: "stdio:fixture", pid: 2_000_000_000 + index,
      processStartIdentity: `fixture:${index}`, eventCursor: gone || index <= 520 && scenario === "paging" ? 10 : 12,
      protocolVersion: null, activeTurnRef: index === 2 && scenario !== "paging" ? "busy-turn" : null,
      pendingAttention: [], activeFlags: index === 4 && scenario !== "paging" ? ["protected"] : [], account: null,
    }, 1);
    // Production host builder supplies all columns; fix its kernel-domain fact.
    columns.process!.bootEpoch = "fixture-boot";
    entries[key] = { key: { engine: "codex", sessionId: id }, artifactPath: pathname, cwd: "/fixture",
      status: "idle", host: null, structuredHost: columns, claimEpoch: 1, claimOwner: null,
      accountId: null, pendingAction: null, structuredHostOperationId: null,
      updatedAt: new Date(NOW - 48 * 3_600_000 + index).toISOString() };
    const conversationId = `conversation_fixture_${index}`;
    conversations[conversationId] = { id: conversationId, engine: "codex",
      projectOwnership: { project: "fixture-project", source: "operator", setAt: new Date(NOW).toISOString(), operationId: "fixture" },
      generations: [{ id, path: pathname }], turn: { state: "idle", source: "assistant" },
      createdAt: new Date(NOW - 48 * 3_600_000).toISOString(), updatedAt: new Date(NOW).toISOString() };
  }
  // The production normalizer builds defaults and validates persisted fixtures.
  fs.writeFileSync(filename, JSON.stringify(normalizeRegistry({ version: 2, entries, conversations, receipts: {} })));
}
const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", now: () => NOW });
setAgentRegistryForTests(registry);
const terminated: string[] = [];
let publication: "ready" | "unbound" = "ready";
let revived = false;
if (gone && scenario !== "gone") {
  const admit = registry.deliveryWriteOrBusy.bind(registry);
  let first = true;
  registry.deliveryWriteOrBusy = async (correlation, write) => {
    if (first) {
      first = false;
      await Promise.resolve();
      const key = `codex:${session(1)}`;
      const entry = registry.readOnlySnapshot().entries[key]!;
      if (scenario === "gone-replaced") registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1,
        structuredHost: { ...entry.structuredHost!, process: { ...entry.structuredHost!.process!, pid: 2_000_001_000 } } });
      if (scenario === "gone-survivor") registry.upsert({ ...entry,
        structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] });
      if (scenario === "gone-revived") revived = true;
      if (scenario === "gone-unbound") publication = "unbound";
      if (scenario === "gone-failure") throw new Error("fixture writer deadline expired");
    }
    return admit(correlation, write);
  };
}
const dependencies: StructuredHostRetirementDependencies = {
  publicationState: () => publication, handoffRows: () => determined([]),
  durableEventTail: () => determined(12), realtimeBound: () => determined(false),
  orchestratorSeatConversations: () => determined(new Set(scenario === "paging" ? [] : ["conversation_fixture_3"])),
  revokedSeatConversations: () => determined(new Set()),
  transcriptStat: () => determined({ mtimeMs: NOW - 24 * 3_600_000 }),
  processIdentity: pid => determined(`fixture:${pid - 2_000_000_000}`), bootEpoch: () => determined("fixture-boot"),
  processMemory: pids => new Map([...pids].map(pid => [pid, { rssBytes: 100, swapBytes: 20 }])),
  ppidMap: () => new Map(), owned: () => true, now: () => NOW,
  terminate: async ref => {
    terminated.push(ref.sessionId!);
    registry.terminateStructuredHost({ engine: ref.engine, sessionId: ref.sessionId! },
      { pid: ref.pid, startIdentity: ref.startIdentity, bootEpoch: ref.bootEpoch });
    return { ok: true, via: "runtime", pids: [ref.pid] };
  },
  // Bun runs this fixture against the base too; unknown dependency fields are inert there.
  ...{ pidAlive: scenario === "gone" ? undefined : (pid: number) => determined(!gone || revived && pid === 2_000_000_001),
    treePss: () => ({ bytes: 60, measuredProcesses: 1 }) },
};
const report = await runStructuredHostRetirementSweep(dependencies);
const status = projectRetirementStatus({ project: "fixture-project" }, {
  readReport: () => fs.readFileSync(statePath("host-retirement-report.json")), now: () => NOW,
  subject: (id, key) => {
    const file = registry.readOnlySnapshot();
    return { conversation: file.conversations[id] ?? null, entry: file.entries[key] ?? null };
  },
});
console.log(JSON.stringify({ report, terminated,
  status: status.status,
  remaining: Object.values(registry.readOnlySnapshot().entries).filter(entry => entry.structuredHost?.process).map(entry => sessionKeyId(entry.key)) }));
registry.close();
