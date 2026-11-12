import { spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { captureProcessIdentity, systemBootEpoch } from "@/lib/processIdentity";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { determined, undetermined } from "./determinable";
import { codexHostColumns } from "./registry";
import { runStructuredHostRetirementSweep, type StructuredHostRetirementDependencies } from "./structuredHostRetirement";
import { claimPass, patchPass, readPass } from "@/lib/memory/curation/store";
import { roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { settle } from "@/lib/memory/curation/admission";
import { defaultSeatTickAdmissionSources } from "@/lib/monitor/seatTickAdmissionSources";
import { defaultSeatTickSources, gatherSeatTickInput } from "@/lib/monitor/seatTickSources";
import { DEFAULT_SEAT_TICK_POLICY } from "@/lib/monitor/seatTick";
import { emptySeatTickState } from "@/lib/monitor/types";
import { terminateStructuredHostTree } from "./structuredHostControl";
import * as hostControl from "./structuredHostControl";
import { projectRetirementStatus } from "./structuredHostRetirementStatus";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const session = (index: number) => ["00000000", "0000", "0000", "0000", String(index).padStart(12, "0")].join("-");
const filename = statePath("fixture-registry.json");
const requested = process.argv[2]!;
const curator = requested.includes("curator");
const scenario = requested.replace("gone-curator", "gone").replace("late-curator", "late").replace("scope-curator", "scope");
const scopeRelease = scenario.startsWith("scope-release");
let scopeRootExited = false;
const terminationErrors: string[] = [];
const gone = scenario.startsWith("gone");
const lateGone = scenario === "gone-after-measurement";
const disappeared = new Set<number>();
const scoped = scopeRelease || scenario.startsWith("gone-scope") || scenario === "gone-exit" || lateGone;
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
  const count = scopeRelease ? 1 : scenario === "batch-progress" ? 1024 : scenario === "batch-wrap" ? 32 : scenario === "paging" ? 524 : 6;
  const indices = Array.from({ length: count }, (_, index) => index + 1);
  // Registration order must not hide a sorted-page starvation regression.
  if (batchScenario) indices.sort((a, b) => Number(refuses(a)) - Number(refuses(b)) || a - b);
  for (const index of indices) {
    const id = session(index);
    const key = `codex:${id}`;
    const pathname = path.join(path.dirname(filename), `${id}.jsonl`);
    const columns = codexHostColumns({
      status: "idle", sessionKey: key, endpoint: "stdio:fixture", pid: 2_000_000_000 + index,
      processStartIdentity: `fixture:${index}`, eventCursor: gone && !lateGone || liveLag || index <= 520 && scenario === "paging" ? 10 : 12,
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
let curatorPidReused = false;
const scopeReads: string[] = [];
if (["gone-cleared", "gone-replaced", "gone-survivor", "gone-revived", "gone-unbound", "gone-failure", "gone-scope-changed", "gone-scope-boot-changed", "gone-claim", "gone-owner", "gone-writer", "gone-start", "gone-boot", "gone-unknown-after-admission"].includes(scenario)) {
  const admit = registry.deliveryWriteOrBusy.bind(registry);
  let first = true;
  registry.deliveryWriteOrBusy = async (correlation, write) => {
    if (first) {
      first = false;
      await Promise.resolve();
      const key = `codex:${session(1)}`;
      const entry = registry.readOnlySnapshot().entries[key]!;
      if (scenario === "gone-scope-changed") {
        registry.terminateStructuredHost(entry.key, entry.structuredHost!.process!, [], undefined, entry.structuredHost!.scope!);
        registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1,
          structuredHost: { ...entry.structuredHost!, scope: { unit: "delegatus-agent-replacement.scope", bootEpoch: currentBoot } } });
      }
      if (scenario === "gone-scope-boot-changed") bootChanged = true;
      if (scenario === "gone-unknown-after-admission") { revived = true; identityUnknown = true; }
      if (scenario === "gone-claim") registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1 });
      if (scenario === "gone-owner") registry.upsert({ ...entry, claimOwner: "replacement-owner" });
      if (scenario === "gone-writer") registry.upsert({ ...entry,
        structuredHost: { ...entry.structuredHost!, writerClaimEpoch: entry.structuredHost!.writerClaimEpoch + 1 } });
      if (scenario === "gone-start" || scenario === "gone-boot") registry.upsert({ ...entry,
        structuredHost: { ...entry.structuredHost!, process: { ...entry.structuredHost!.process!,
          ...(scenario === "gone-start" ? { startIdentity: "replacement-start" } : { bootEpoch: "replacement-boot" }) } } });
      if (scenario === "gone-cleared") registry.terminateStructuredHost(entry.key, entry.structuredHost!.process!);
      if (scenario === "gone-replaced") registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1,
        structuredHost: { ...entry.structuredHost!, process: { ...entry.structuredHost!.process!, pid: 2_000_001_000 } } });
      if (scenario === "gone-survivor") registry.upsert({ ...entry,
        structuredTerminationSurvivors: [captureProcessIdentity(process.ppid)] });
      if (scenario === "gone-revived") revived = true;
      if (scenario === "gone-unbound") publication = "unbound";
      if (scenario === "gone-failure") throw new Error("fixture writer deadline expired");
    }
    return admit(correlation, write);
  };
}
if (scenario === "gone-cas-cleared" || scenario === "gone-cas-replaced" || scenario === "gone-cas-refused") {
  const retire = registry.terminateStructuredHost.bind(registry);
  let first = true;
  registry.terminateStructuredHost = (...args) => {
    if (first) {
      first = false;
      const entry = registry.readOnlySnapshot().entries[`codex:${session(1)}`]!;
      if (scenario === "gone-cas-refused") return false;
      if (scenario === "gone-cas-replaced") {
        registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1,
          structuredHost: { ...entry.structuredHost!, process: { ...entry.structuredHost!.process!, pid: 2_000_001_000 } } });
        return retire(...args);
      }
      retire(...args);
      return false;
    }
    return retire(...args);
  };
}
const dependencies: StructuredHostRetirementDependencies = {
  publicationState: () => publication, handoffRows: () => determined([]),
  durableEventTail: () => determined(12), realtimeBound: () => determined(false),
  orchestratorSeatConversations: () => determined(new Set(paging || liveLag ? [] : ["conversation_fixture_3"])),
  revokedSeatConversations: () => determined(new Set()),
  transcriptStat: () => determined({ mtimeMs: NOW - 24 * 3_600_000 }),
  processIdentity: pid => unknown || identityUnknown ? undetermined("identity read unavailable") : determined(
    curatorPidReused && pid === 2_000_000_001 ? "replacement-process" : reused ? captureProcessIdentity(pid).startIdentity! : `fixture:${pid - 2_000_000_000}`),
  bootEpoch: () => determined(bootChanged ? "changed-boot" : scoped || reused ? currentBoot : "fixture-boot"),
  processMemory: pids => new Map([...pids].map(pid => [pid, { rssBytes: 100, swapBytes: 20 }])),
  ppidMap: () => new Map(), owned: () => true, now: () => NOW,
  terminate: async ref => {
    attempted.push(ref.sessionId!);
    if (batchScenario && refuses(Number(ref.sessionId!.split("-").at(-1)))) {
      return { ok: false, status: 409, error: "fixture termination refused", remaining: [ref.pid], survivors: [] };
    }
    if (scenario.startsWith("late-") && ref.sessionId === session(1)) {
      if (scenario === "late-pid-reuse") curatorPidReused = true;
      const entry = registry.readOnlySnapshot().entries[`codex:${session(1)}`]!;
      const retained = scenario === "late-descendant" ? [{ ...captureProcessIdentity(process.pid), bootEpoch: "fixture-boot" }] : [];
      if (scenario === "late-cleared") registry.terminateStructuredHost(entry.key, entry.structuredHost!.process!);
      else if (!retained.length && scenario !== "late-returned-writer-failure" && scenario !== "late-pid-reuse") registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1,
        structuredHost: { ...entry.structuredHost!, process: { ...entry.structuredHost!.process!, pid: 2_000_001_000 } } });
      if (scenario !== "late-returned-writer-failure") disappeared.add(ref.pid);
      if (scenario === "late-throw") throw new Error("fixture termination writer failed");
      return terminateStructuredHostTree(ref, {
        registryCustody: { process: entry.structuredHost!.process!, claimOwner: entry.claimOwner,
          claimEpoch: entry.claimEpoch, writerClaimEpoch: entry.structuredHost!.writerClaimEpoch },
        retainedSurvivors: retained,
        processIdentity: pid => scenario === "late-pid-reuse" && pid === ref.pid
          ? "replacement-process"
          : scenario === "late-returned-writer-failure" && pid === ref.pid && !disappeared.has(pid)
          ? ref.startIdentity : retained.find(identity => identity.pid === pid)?.startIdentity ?? null,
        pidAlive: pid => scenario === "late-pid-reuse" && pid === ref.pid
          || scenario === "late-returned-writer-failure" && pid === ref.pid && !disappeared.has(pid)
          || retained.some(identity => identity.pid === pid),
        ...(scenario === "late-returned-writer-failure" ? { retireRegistryEntry: async () => {
          throw new Error("fixture registry write failed");
        } } : {}),
        bootEpoch: () => "fixture-boot", protectedPids: () => new Set(),
        scope: null,
        authorize: () => retained.length ? { status: 409, error: "retained descendant custody remains active" } : null,
        signal: () => { throw new Error("finished curator must not be signalled"); },
        terminateOwnedHost: async () => {
          if (scenario === "late-returned-writer-failure") {
            disappeared.add(ref.pid);
            return true;
          }
          throw new Error("finished curator must not be released");
        },
      });
    }
    terminated.push(ref.sessionId!);
    registry.terminateStructuredHost({ engine: ref.engine, sessionId: ref.sessionId! },
      { pid: ref.pid, startIdentity: ref.startIdentity, bootEpoch: ref.bootEpoch });
    return { ok: true, via: "runtime", pids: [ref.pid] };
  },
  // Bun runs this fixture against the base too; unknown dependency fields are inert there.
  ...{ pidAlive: scenario === "gone" ? undefined : (pid: number) => determined(!scopeRootExited && ((lateGone && !disappeared.has(pid)) || reused || !gone && !disappeared.has(pid) || revived && pid === 2_000_000_001)),
    scopeLoadState: async (scope: { unit: string }) => {
      scopeReads.push(scope.unit);
      if (scopeRelease) {
        await Promise.resolve();
        const key = { engine: "codex" as const, sessionId: session(1) };
        const entry = registry.hostEntry(key)!;
        if (scenario === "scope-release-read-claim") registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1 });
        if (scenario === "scope-release-read-owner") registry.upsert({ ...entry, claimOwner: "replacement-owner" });
        if (scenario === "scope-release-read-writer") registry.upsert({ ...entry,
          structuredHost: { ...entry.structuredHost!, writerClaimEpoch: entry.structuredHost!.writerClaimEpoch + 1 } });
        if (scenario === "scope-release-read-boot") bootChanged = true;
        if (scenario === "scope-release-read-publication") publication = "unbound";
      }
      if (scenario === "gone-scope-unknown") throw new Error("scope read unavailable");
      if (scenario === "scope-release-unreadable") throw new Error("fixture scope read failed");
      return scenario === "gone-scope-live" || scenario === "scope-release-loaded" ? "loaded" : "not-found";
    },
    treePss: async (pids: readonly number[]) => {
      await Promise.resolve();
      if (lateGone) for (const pid of pids) disappeared.add(pid);
      return { bytes: 60, measuredProcesses: 1 };
    } },
};
// Exercise the sweep's default authorizer and the real termination ladder.
// Only native effects and kernel observations belong to this fixture.
if (scopeRelease) {
  delete dependencies.terminate;
  const terminate = hostControl.terminateStructuredHostTree;
  spyOn(hostControl, "terminateStructuredHostTree").mockImplementation(async (ref, options) => {
    const outcome = await terminate(ref, {
      ...options,
      pidAlive: pid => pid === ref.pid + 1 && scenario === "scope-release-descendant" || !scopeRootExited,
      processIdentity: pid => pid === ref.pid + 1 ? "fixture:2" : scopeRootExited ? null : "fixture:1",
      bootEpoch: () => currentBoot,
      ppidMap: () => new Map(scenario === "scope-release-descendant" ? [[ref.pid, 1], [ref.pid + 1, ref.pid]] : [[ref.pid, 1]]),
      processGroupId: () => null,
      protectedPids: () => new Set(),
      signal: () => { throw new Error("fixture must never signal a process"); },
      stopScope: async () => { throw new Error("fixture must never stop a scope"); },
      terminateOwnedHost: async () => {
        attempted.push(ref.sessionId!);
        await Promise.resolve();
        const entry = registry.hostEntry({ engine: ref.engine, sessionId: ref.sessionId! })!;
        scopeRootExited = scenario !== "scope-release-live";
        registry.setStructuredHost(entry.key, entry.structuredHost!, "unhosted");
        if (scenario === "scope-release-replaced") {
          const expected = entry.structuredHost!.process!;
          if (!registry.terminateStructuredHost(entry.key, expected, [expected], undefined, entry.structuredHost!.scope!)) {
            throw new Error("fixture could not retire original custody");
          }
          registry.upsert({ ...entry, claimEpoch: entry.claimEpoch + 1,
            structuredHost: { ...entry.structuredHost!, process: { ...expected, pid: 2_000_001_000 },
              scope: { unit: "delegatus-agent-replacement.scope", bootEpoch: currentBoot } } });
        }
        return true;
      },
    });
    if (!outcome.ok) terminationErrors.push(outcome.error);
    return outcome;
  });
}
const curatorIdFile = statePath("fixture-curation-pass.json");
if (curator && !fs.existsSync(curatorIdFile)) {
  const scope = roleScope("fixture-project", "builder");
  roleMemoryCollection(true)!.boundedPatch(2, tx => {
    tx.put({ kind: "rule", id: "r_retirement_fixture", scope, state: "active", rule: "Verify host custody before cleanup.",
      why: "Preserve replacement hosts.", hints: [], source: { project: "fixture-project", pipelineId: "fixture", stageId: "build", attempt: 1,
        roleId: "builder", fixRound: false, conversationId: "conversation_fixture_1" },
      createdAt: new Date(NOW).toISOString(), changedAt: new Date(NOW).toISOString() });
    tx.put({ kind: "scope", scope, revision: 1, history: [], active: ["r_retirement_fixture"] });
  });
  const pass = claimPass({ project: "fixture-project", repoDir: null, now: NOW })!;
  if (!pass) throw new Error("fixture curator pass was not claimed");
  const running = patchPass(pass.id, { state: "running", conversationId: "conversation_fixture_1", launchedAt: new Date(NOW).toISOString() })!;
  fs.writeFileSync(curatorIdFile, JSON.stringify(pass.id));
  settle(running, { sources: { ...defaultSeatTickAdmissionSources(), now: () => NOW }, archive: () => {} }, null, "Curation completed");
}
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
let curation;
let signals;
if (curator) {
  curation = readPass(JSON.parse(fs.readFileSync(curatorIdFile, "utf8")));
  const input = await gatherSeatTickInput("fixture-project", emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, {
    now: () => NOW, registry: () => registry,
    settings: defaultSeatTickSources().settings, lifecycleJournal: defaultSeatTickSources().lifecycleJournal,
    openPullRequests: async () => ({ ok: true, pullRequests: [] }),
    wakeState: async () => "retained", withdrawWake: async () => "withdrawn",
    seatFor: () => ({ active: null, pending: null, history: [] }), activeSeats: () => [],
    pipelines: () => [], archivedPipelines: () => [], tasks: () => [], liveness: async () => [],
    latestDeployment: () => ({ state: "ok", value: null }),
    retirementReport: () => JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8")),
    retirementJournal: () => ({ covered: false, sweeps: [] }),
  });
  signals = input.signals.filter(signal => signal.id === "host-retirement");
}
console.log(JSON.stringify({ report, terminated, attempted, scopeReads, historyIntact, curation, signals, terminationErrors,
  status: status.status,
  remaining: Object.values(registry.readOnlySnapshot().entries).filter(entry => entry.structuredHost?.process).map(entry => sessionKeyId(entry.key)),
  remainingRows: Object.values(registry.readOnlySnapshot().entries).filter(entry => entry.structuredHost?.process)
    .map(entry => ({ key: sessionKeyId(entry.key), claimEpoch: entry.claimEpoch, pid: entry.structuredHost!.process!.pid })) }));
registry.close();
