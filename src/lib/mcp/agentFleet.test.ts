import { expect, test } from "bun:test";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { ResourceSession } from "@/lib/types";
import { fleetAgents, fleetDetailRows, fleetLimitWaits, fleetPublicRow, fleetRuntimeFor, fleetSummary } from "./agentFleet";
import { fleetAccounts, fleetEntry, fleetPipeline, fleetRegistry, fleetRow, FLEET_NOW } from "./agentFleet.fixture";

test("counts engine, model, effort, account, placement and independent waits", () => {
  const rows = [fleetRow("one", { pipeline: { pipelineId: "pipeline-one", stageId: "build", attempt: 1 } as never }),
    fleetRow("two", { lifecycle: "waiting", turnState: "idle", engine: "codex", reason: "provider_throttled" }),
    fleetRow("three", { lifecycle: "stalled", reason: "permission_request", permission: { tool: "shell", reason: "Confirm", since: "now" } as never })];
  const registry = fleetRegistry(rows);
  registry.entries[rows[1].transcriptPath].launchProfile = emptyLaunchProfile({ model: "fable", effort: "xhigh" });
  const agents = fleetAgents(rows, fleetRuntimeFor(rows, registry), new Set([rows[1].conversationId!]), fleetLimitWaits([fleetPipeline(rows[0])]), []);
  const summary = fleetSummary(agents, fleetAccounts(), { project: "project-one" }, new Date(FLEET_NOW).toISOString());
  expect(summary.agents).toEqual({ live: 3, running: 1, waiting: 1, stalled: 1, limitWait: 1, throttled: 1, permission: 1 });
  expect(summary.where).toEqual({ pipeline: 1, seat: 1, other: 1 });
  expect(summary.byEngine).toEqual({ claude: [2, 1], codex: [1, 0] });
  expect(summary.byModel).toEqual({ opus: [2, 1], fable: [1, 0] });
  expect(summary.byEffort).toEqual({ high: [2, 1], xhigh: [1, 0] });
  expect(summary.accounts[0]).toEqual({ engine: "claude", account: "account-one", agents: [2, 1], session: [100, "2026-10-12T16:00:00.000Z"], weekly: 43, active: true, fresh: false, limitWait: 1 });
});

test("limit waits ignore acted, historical, superseded and closed attempts and other provider conditions", () => {
  const row = fleetRow();
  expect(fleetLimitWaits([fleetPipeline(row, "acted")]).size).toBe(0);
  for (const change of ["closed", "completed", "historical", "replaced", "transient"]) {
    const pipeline = fleetPipeline(row);
    if (change === "closed" || change === "completed") pipeline.state = change;
    if (change === "historical") pipeline.runs[0].attempts[0].historical = true;
    if (change === "replaced") pipeline.runs[0].attempts.push({ n: 2, conversationId: row.conversationId } as never);
    if (change === "transient") pipeline.runs[0].attempts[0].providerWait!.condition.kind = "transient";
    expect(fleetLimitWaits([pipeline]).size).toBe(0);
  }
});

test("runtime prefers the observed live host then generation then receipt, never a path account", () => {
  const row = fleetRow(); row.transcriptPath = "/sessions/account-lookalike/one.jsonl";
  const registry = fleetRegistry([row]);
  registry.entries.old = fleetEntry(row, { status: "dead", accountId: "old-account", updatedAt: "later" });
  registry.conversations[row.conversationId!] = { generations: [{ accountId: "generation-account", launchProfile: emptyLaunchProfile({ model: "generation-model" }) }] } as never;
  registry.receipts.one = { conversationId: row.conversationId, accountId: "receipt-account", launchProfile: emptyLaunchProfile({ model: "receipt-model" }), createdAt: "now" } as never;
  const read = () => fleetRuntimeFor([row], registry)(row);
  expect(read()).toMatchObject({ account: "account-one", model: "opus", effort: "high" });
  registry.entries = {};
  expect(read()).toMatchObject({ account: "generation-account", model: "generation-model", effort: "default" });
  registry.conversations = {};
  expect(read()).toMatchObject({ account: "receipt-account", model: "receipt-model", effort: "default" });
  registry.receipts = {};
  expect(read()).toMatchObject({ account: "unknown", model: "unknown", effort: "unknown" });
  registry.entries.one = fleetEntry(row, { accountId: null, launchProfile: emptyLaunchProfile() });
  expect(read()).toMatchObject({ account: "unknown", model: "default", effort: "default" });
});

test("active accounts with no agents and optional activity retain their meaning", () => {
  const row = fleetRow(), registry = fleetRegistry([row]);
  const agents = fleetAgents([row], fleetRuntimeFor([row], registry), new Set(), new Map(), []);
  expect(fleetSummary([], fleetAccounts(), "all", "now").accounts[0].agents).toEqual([0, 0]);
  expect(fleetSummary(agents, [], "all", "now").agents).not.toHaveProperty("activity");
  agents[0].activity = { state: "checking" };
  expect(fleetSummary(agents, [], "all", "now").agents).toMatchObject({ running: 1, activity: { working: 0, checking: 1, idle: 0 } });
});

for (const size of [20, 200]) test(`summary stays under 2048 bytes for ${size} agents with busy accounts`, () => {
  const rows = Array.from({ length: size }, (_, i) => fleetRow(String(i)));
  const registry = fleetRegistry(rows);
  rows.forEach((row, i) => { registry.entries[row.transcriptPath].accountId = `account-${i % 12}`;
    registry.entries[row.transcriptPath].launchProfile = emptyLaunchProfile({ model: `model-${i % 10}`, effort: i % 2 ? "high" : "xhigh" }); });
  const agents = fleetAgents(rows, fleetRuntimeFor(rows, registry), new Set(), new Map(), []);
  const accounts = Array.from({ length: 12 }, (_, i) => ({ ...fleetAccounts()[0], accountId: `account-${i}`, active: i === 0 }));
  const summary = fleetSummary(agents, accounts, "all", new Date(FLEET_NOW).toISOString());
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(2048);
  expect(summary.agents.live).toBe(size);
  expect(Object.values(summary.byModel).reduce((n, pair) => n + pair[0], 0)).toBe(size);
  expect(summary.accounts.reduce((n, row) => n + row.agents[0], summary.moreAccountAgents?.[0] ?? 0)).toBe(size);
  expect(summary.accounts[0].active).toBe(true);
});

test("filters combine, use durable values and omit transcript paths, cwd and text", () => {
  const row = fleetRow("one", { pipeline: { pipelineId: "pipeline-one", stageId: "build", attempt: 1 } as never });
  const other = fleetRow("two", { lifecycle: "waiting" });
  const agents = fleetAgents([row, other], fleetRuntimeFor([row, other], fleetRegistry([row, other])), new Set(), fleetLimitWaits([fleetPipeline(row)]), []);
  for (const filters of [{ pipelineId: "pipeline-one" }, { conversationId: "conversation_one" }, { state: "running" as const }, { state: "limitWait" as const }]) {
    expect(fleetDetailRows(agents, filters).map(row => row.conversationId)).toEqual(["conversation_one"]);
  }
  for (const key of ["engine", "model", "effort", "account"] as const) {
    expect(fleetDetailRows(agents, { [key]: "missing" })).toHaveLength(0);
    expect(fleetDetailRows(agents, { [key]: agents[0][key], conversationId: "conversation_one" })).toHaveLength(1);
  }
  agents[1].throttled = true; agents[1].permissionWaiting = true; agents[1].permission = { tool: "shell", reason: null, since: "now" };
  expect(fleetDetailRows(agents, { state: "throttled" })).toHaveLength(1);
  expect(fleetDetailRows(agents, { state: "permission" })).toHaveLength(1);
  expect(fleetDetailRows(agents, { state: "waiting" })).toHaveLength(1);
  const detail = fleetPublicRow(agents[0], { project: "project-one" });
  for (const field of ["transcriptPath", "cwd", "text", "project", "seat", "throttled"]) expect(detail).not.toHaveProperty(field);
  expect(fleetPublicRow(agents[0], "all")).toHaveProperty("project", "project-one");
});

test("memory comes from the session cache and host memory record, with stale evidence named", () => {
  const row = fleetRow(), registry = fleetRegistry([row]);
  registry.entries[row.transcriptPath].structuredHost!.memory = { mechanism: "watchdog", limitBytes: 4096 * 2 ** 20, unit: null, kills: 2, lastKill: null };
  const sessions = [{ conversationId: row.conversationId, rssBytes: 1398 * 2 ** 20, procCount: 3 }] as ResourceSession[];
  const agent = fleetAgents([row], fleetRuntimeFor([row], registry), new Set(), new Map(), sessions, true)[0];
  expect(agent).toMatchObject({ rssMB: 1398, procs: 3, memLimitMB: 4096, memKills: 2, memStale: true });
  expect(agent).not.toHaveProperty("cpu");
});

test("folding copes with long aliases and preserves unknown account counts", () => {
  const row = fleetRow(), registry = fleetRegistry([row]);
  registry.entries[row.transcriptPath].launchProfile!.model = "long".repeat(1000);
  registry.entries[row.transcriptPath].accountId = null;
  const agents = fleetAgents([row], fleetRuntimeFor([row], registry), new Set(), new Map(), []);
  const summary = fleetSummary(agents, [], "all", "now");
  expect(summary.byModel).toEqual({ other: [1, 1] });
  expect(summary.accounts[0].account).toBe("unknown");
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(2048);
});


test("a limit wait is attributed to its recorded account and permission counts survive missing detail", () => {
  const row = fleetRow("one", { reason: "permission_request" });
  const pipeline = fleetPipeline(row); pipeline.runs[0].attempts[0].providerWait!.accountId = "waiting-account";
  const agents = fleetAgents([row], fleetRuntimeFor([row], fleetRegistry([row])), new Set(), fleetLimitWaits([pipeline]), []);
  const summary = fleetSummary(agents, [], "all", "now");
  expect(summary.agents.permission).toBe(1);
  expect(fleetDetailRows(agents, {state:"permission"})).toHaveLength(1);
  expect(summary.accounts.find(row => row.account === "waiting-account")).toMatchObject({agents:[0,0],limitWait:1});
  expect(summary.accounts.find(row => row.account === "account-one")).not.toHaveProperty("limitWait");
});
