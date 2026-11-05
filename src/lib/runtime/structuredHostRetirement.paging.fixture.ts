import fs from "node:fs";
import path from "node:path";
import { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { captureProcessIdentity, systemBootEpoch } from "@/lib/processIdentity";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { determined, undetermined } from "./determinable";
import { codexHostColumns } from "./registry";
import { runStructuredHostRetirementSweep, type StructuredHostRetirementDependencies } from "./structuredHostRetirement";
import { projectRetirementStatus } from "./structuredHostRetirementStatus";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const session = (index: number) => ["00000000", "0000", "0000", "0000", String(index).padStart(12, "0")].join("-");
const filename = statePath("fixture-registry.json");
const scenario = process.argv[2]!;
const gone = scenario.startsWith("gone");
const scoped = scenario.startsWith("gone-scope") || scenario === "gone-exit";
const currentBoot = systemBootEpoch()!;
const oldBoot = `linux:${["00000000", "0000", "0000", "0000", "000000000000"].join("-")}:pidns:pid:[1]`;
const reused = scenario === "gone-reused";
const unknown = scenario === "identity-unknown";
const liveLag = scenario === "live-lag" || unknown;
const batchScenario = scenario.startsWith("batch-");
const paging = scenario === "paging" || batchScenario;
const refuses = (index: number) => scenario === "batch-wrap" || index <= 8 || index >= 513 && index <= 520;
if (!fs.existsSync(filename)) {
  const entries: Record<string, unknown> = {};
  const conversations: Record<string, unknown> = {};
  const count = scenario === "batch-progress" ? 1024 : scenario === "batch-wrap" ? 32 : scenario === "paging" ? 524 : 6;
  const indices = Array.from({ length: count }, (_, index) => index + 1);
  // Registration order must not hide a sorted-page starvation regression.
  if (batchScenario) indices.sort((a, b) => Number(refuses(a)) - Number(refuses(b)) || a - b);
  for (const index of indices) {
    const id = session(index);
    const key = `codex:${id}`;
    const pathname = path.join(path.dirname(filename), `${id}.jsonl`);
    const columns = codexHostColumns({
      status: "idle", sessionKey: key, endpoint: "stdio:fixture", pid: 2_000_000_000 + index,
      processStartIdentity: `fixture:${index}`, eventCursor: gone || liveLag || index <= 520 && scenario === "paging" ? 10 : 12,
      protocolVersion: null, activeTurnRef: index === 2 && !paging ? "busy-turn" : null,
      pendingAttention: [], activeFlags: index === 4 && !paging ? ["protected"] : [], account: null,
    }, 1);
    // Production host builder supplies all columns; fix its kernel-domain fact.
    columns.process!.bootEpoch = "fixture-boot";
    if (scoped) {
      columns.scope = { unit: `delegatus-agent-fixture-${index}.scope`, bootEpoch: scenario === "gone-scope-old" && process.platform === "linux" ? oldBoot : currentBoot };
      columns.process!.bootEpoch = columns.scope.bootEpoch;
      if (scenario === "gone-exit") { columns.exitProcess = columns.process!; columns.process = null; }
    }
    if (reused) columns.process = { ...captureProcessIdentity(process.pid), startIdentity: "previous-process" };
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { role: "user", content: "retained conversation" } }) + "\n");
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
const attempted: string[] = [];
let publication: "ready" | "unbound" = "ready";
let revived = false;
let bootChanged = false;
let identityUnknown = false;
const scopeReads: string[] = [];
if (["gone-replaced", "gone-survivor", "gone-revived", "gone-unbound", "gone-failure", "gone-scope-changed", "gone-scope-boot-changed", "gone-claim", "gone-owner", "gone-writer", "gone-start", "gone-boot", "gone-unknown-after-admission"].includes(scenario)) {
  const admit = registry.deliveryWriteOrBusy.bind(registry);
  let first = true;
  registry.deliveryWriteOrBusy = async (correlation, write) => {
    if (first) {
      first = false;
      await Promise.resolve();
      const key = `codex:${session(1)}`;
      const entry = registry.readOnlySnapshot().entries[key]!;
      if (scenario === "gone-scope-changed") registry.upsert({ ...entry,
        structuredHost: { ...entry.structuredHost!, scope: { unit: "delegatus-agent-replacement.scope", bootEpoch: currentBoot } } });
      if (scenario === "gone-scope-boot-changed") bootChanged = true;
      if (scenario === "gone-unknown-after-admission") { revived = true; identityUnknown = true; }
      if (scenario === "gone-claim") registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1 });
      if (scenario === "gone-owner") registry.upsert({ ...entry, claimOwner: "replacement-owner" });
      if (scenario === "gone-writer") registry.upsert({ ...entry,
        structuredHost: { ...entry.structuredHost!, writerClaimEpoch: entry.structuredHost!.writerClaimEpoch + 1 } });
      if (scenario === "gone-start" || scenario === "gone-boot") registry.upsert({ ...entry,
        structuredHost: { ...entry.structuredHost!, process: { ...entry.structuredHost!.process!,
          ...(scenario === "gone-start" ? { startIdentity: "replacement-start" } : { bootEpoch: "replacement-boot" }) } } });
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
  orchestratorSeatConversations: () => determined(new Set(paging || liveLag ? [] : ["conversation_fixture_3"])),
  revokedSeatConversations: () => determined(new Set()),
  transcriptStat: () => determined({ mtimeMs: NOW - 24 * 3_600_000 }),
  processIdentity: pid => unknown || identityUnknown ? undetermined("identity read unavailable") : determined(reused ? captureProcessIdentity(pid).startIdentity! : `fixture:${pid - 2_000_000_000}`),
  bootEpoch: () => determined(bootChanged ? "changed-boot" : scoped || reused ? currentBoot : "fixture-boot"),
  processMemory: pids => new Map([...pids].map(pid => [pid, { rssBytes: 100, swapBytes: 20 }])),
  ppidMap: () => new Map(), owned: () => true, now: () => NOW,
  terminate: async ref => {
    attempted.push(ref.sessionId!);
    if (batchScenario && refuses(Number(ref.sessionId!.split("-").at(-1)))) {
      return { ok: false, status: 409, error: "fixture termination refused", remaining: [ref.pid], survivors: [] };
    }
    terminated.push(ref.sessionId!);
    registry.terminateStructuredHost({ engine: ref.engine, sessionId: ref.sessionId! },
      { pid: ref.pid, startIdentity: ref.startIdentity, bootEpoch: ref.bootEpoch });
    return { ok: true, via: "runtime", pids: [ref.pid] };
  },
  // Bun runs this fixture against the base too; unknown dependency fields are inert there.
  ...{ pidAlive: scenario === "gone" ? undefined : (pid: number) => determined(reused || !gone || revived && pid === 2_000_000_001),
    scopeLoadState: async (scope: { unit: string }) => {
      scopeReads.push(scope.unit);
      if (scenario === "gone-scope-unknown") throw new Error("scope read unavailable");
      return scenario === "gone-scope-live" ? "loaded" : "not-found";
    },
    treePss: () => ({ bytes: 60, measuredProcesses: 1 }) },
};
const before = registry.readOnlySnapshot();
const report = await runStructuredHostRetirementSweep(dependencies);
const status = projectRetirementStatus({ project: "fixture-project" }, {
  readReport: () => fs.readFileSync(statePath("host-retirement-report.json")), now: () => NOW,
  subject: (id, key) => {
    const file = registry.readOnlySnapshot();
    return { conversation: file.conversations[id] ?? null, entry: file.entries[key] ?? null };
  },
});
const after = registry.readOnlySnapshot();
const historyIntact = Object.values(before.entries).every(entry =>
  after.entries[sessionKeyId(entry.key)]?.artifactPath === entry.artifactPath &&
  fs.readFileSync(entry.artifactPath, "utf8").includes("retained conversation")) &&
  JSON.stringify(after.conversations) === JSON.stringify(before.conversations);
console.log(JSON.stringify({ report, terminated, attempted, scopeReads, historyIntact,
  status: status.status,
  remaining: Object.values(registry.readOnlySnapshot().entries).filter(entry => entry.structuredHost?.process).map(entry => sessionKeyId(entry.key)) }));
registry.close();
