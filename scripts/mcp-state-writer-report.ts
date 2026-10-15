/* Aggregates only the synthetic state-writer mode's saved observations. */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

type Event = { pid: number; connection: number; database: string; event: string; value: number; atNs: number; atMs: number; call?: string; collection?: string; sql?: string; duration?: number };
type Process = { pid: number; start: string; main: number; wal: number; shm: number; cpuTicks: number; rssPages: number };
const read = <T>(root: string, file: string): T => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const lines = <T>(root: string, file: string): T[] => fs.readFileSync(path.join(root, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as T);
async function* stream<T>(root: string, file: string): AsyncGenerator<T> {
  const input = createInterface({ input: fs.createReadStream(path.join(root, file)), crlfDelay: Infinity });
  for await (const line of input) if (line) yield JSON.parse(line) as T;
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const distribution = (values: number[]) => {
  values.sort((a, b) => a - b);
  const at = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
  return { count: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};

export async function stateWriterReport(root: string) {
  const bounds = read<{ coldEnd: number; warmEnd: number; measuredEnd: number; seconds: number }>(root, "boundaries.json");
  const summary = read<{ completed: number }>(root, "summary.json");
  const census = lines<{ at: number; processes: Process[] }>(root, "census.ndjson");
  const viewer = read<{ pid: number }>(root, "viewer.ready").pid;
  const servers = new Set<number>();
  const executors = new Set<number>();
  const registeredProcesses = new Set<string>();
  const role = (pid: number) => pid === viewer ? "viewer" : executors.has(pid) ? "executor" : servers.has(pid) ? "adapter" : "launcher";
  const phase = (at: number) => at < bounds.coldEnd ? "cold" : at < bounds.warmEnd ? "warm" : at < bounds.measuredEnd ? "measured" : "drain";
  const measured = (event: Event) => phase(event.atMs) === "measured";
  const affectedCalls = new Set<string>();
  const unfinished = new Map<string, Event>();
  let busyResults = 0, applicationWaitMs = 0, heldLeaseRefusals = 0, leaseSqlRefusals = 0, leaseRetryWaitMs = 0, failedOpens = 0;
  const leaseAcquisitionMs: number[] = [];
  for await (const event of stream<Event>(root, "sql.ndjson.js")) {
    if (event.event === "process") registeredProcesses.add(`${event.pid}:${(event as Event & { identity: string }).identity}`);
    if (event.event === "process" && event.pid !== viewer) servers.add(event.pid);
    if (event.event === "task-executor-process") executors.add(event.pid);
    const call = `${event.pid}:${event.call}`;
    if (event.event === "call-start") unfinished.set(call, event);
    if (event.event === "call-end") unfinished.delete(call);
    if (!measured(event)) continue;
    if (event.event === "busy-result") {
      busyResults++;
      if (event.call) affectedCalls.add(`${event.pid}:${event.call}`);
    }
    if (event.event === "open-failed") failedOpens++;
    if (event.event === "application-sync-wait-ns") applicationWaitMs += (event.duration ?? 0) / 1e6;
    if (event.event === "lease-held-refusal") heldLeaseRefusals++;
    if (event.event === "lease-sql-refusal") leaseSqlRefusals++;
    if (event.event === "lease-retry-wait-ns") leaseRetryWaitMs += (event.duration ?? 0) / 1e6;
    if (event.event === "lease-acquisition-ns") leaseAcquisitionMs.push((event.duration ?? 0) / 1e6);
  }
  const active = new Map<string, Event>();
  const counts = new Map<string, { role: string; pid: number; database: string; opened: number; readonly: number; closed: number; current: number; peak: number; reclaimedAtExit: number; lifetimeMs: number[] }>();
  const phases = new Map<string, Record<string, number>>();
  const leases = new Map<string, number>();
  const collectionLease = new Map<string, string>();
  let staleLeaseRemovals = 0, unobservedLeaseRemovals = 0;
  const holds: number[] = [], pending = new Map<string, Event[]>();
  const commitKinds: Record<string, number> = {};
  const byDatabase: Record<string, Record<string, number>> = {};
  let commits = 0, opens = 0, zeroChangedCommits = 0, committedChanges = 0, busyHandlerSleeps = 0, busyHandlerWaitMs = 0;
  for await (const event of stream<Event>(root, "sql.ndjson")) {
    if (measured(event)) {
      const database = byDatabase[event.database] ??= {};
      database[event.event] = (database[event.event] ?? 0) + (event.event === "commit" || event.event === "committed-changes" || event.event === "sqlite-sleep-ns" ? event.value : 1);
      if (event.event === "commit") commits += event.value;
      if (event.event === "open") opens++;
      if (event.event === "committed-changes") { committedChanges += event.value; if (!event.value) zeroChangedCommits++; }
      if (event.event === "sqlite-sleep-ns") {
        busyHandlerSleeps++; busyHandlerWaitMs += event.value / 1e6;
        if (event.call) affectedCalls.add(`${event.pid}:${event.call}`);
      }
    }
    const key = `${event.pid}:${event.database}`, connection = `${event.pid}:${event.connection}`;
    const group = counts.get(key) ?? { role: role(event.pid), pid: event.pid, database: event.database, opened: 0, readonly: 0, closed: 0, current: 0, peak: 0, reclaimedAtExit: 0, lifetimeMs: [] };
    counts.set(key, group);
    const phaseKey = `${phase(event.atMs)}:${role(event.pid)}:${event.database}:${event.collection || "unattributed"}`;
    const counters = phases.get(phaseKey) ?? {};
    counters[event.event] = (counters[event.event] ?? 0) + (["commit", "committed-changes", "sqlite-sleep-ns"].includes(event.event) ? event.value : 1);
    phases.set(phaseKey, counters);
    if (event.event === "open") {
      if (active.has(connection)) throw new Error(`Duplicate connection ${connection}`);
      active.set(connection, event); group.opened++; group.readonly += event.value === 1 ? 1 : 0;
      group.peak = Math.max(group.peak, ++group.current);
    }
    if (event.event === "close") {
      const opened = active.get(connection);
      if (!opened) throw new Error(`Close without open ${connection}`);
      group.closed++; group.current--; group.lifetimeMs.push((event.atNs - opened.atNs) / 1e6); active.delete(connection);
    }
    if (event.event === "rollback" || event.event === "begin") pending.delete(connection);
    if (event.event === "lease-statement" && event.value > 0 && /^(INSERT|DELETE)\b/i.test(event.sql?.trim() ?? "")) {
      const statements = pending.get(connection) ?? []; statements.push(event); pending.set(connection, statements);
    }
    if (event.event === "commit") {
      for (const statement of pending.get(connection) ?? []) {
        const strings = [...statement.sql!.matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replaceAll("''", "'"));
        const collection = `${statement.database}:${strings[0]}`;
        const token = strings[1] ?? collectionLease.get(collection);
        if (/^INSERT/i.test(statement.sql!.trim())) {
          if (!token) throw new Error("Lease acquisition lacked its owner token");
          leases.set(token, event.atNs); collectionLease.set(collection, token);
        }
        else {
          if (!strings[1]) staleLeaseRemovals++;
          const acquired = token ? leases.get(token) : undefined;
          if (acquired !== undefined) { if (measured(event)) holds.push((event.atNs - acquired) / 1e6); leases.delete(token!); }
          else unobservedLeaseRemovals++;
          if (collectionLease.get(collection) === token) collectionLease.delete(collection);
        }
      }
      pending.delete(connection);
    }
    if (event.event === "commit-kinds" && measured(event)) {
      // A transaction can touch several categories; the commit total above
      // counts it once. Bit zero means a successful empty/read transaction.
      for (const [name, bit] of Object.entries({ schema: 1, leaseAcquire: 2, domain: 4, leaseRelease: 8, receipt: 16, other: 32 })) {
        if (event.value & bit) commitKinds[name] = (commitKinds[name] ?? 0) + 1;
      }
      if (event.value === 0) commitKinds.empty = (commitKinds.empty ?? 0) + 1;
    }
  }
  const teardown = read<Process[]>(root, "teardown.json");
  if (teardown.length) throw new Error("Fixture processes survived teardown");
  for (const event of active.values()) counts.get(`${event.pid}:${event.database}`)!.reclaimedAtExit++;
  for (const group of counts.values()) if (group.opened !== group.closed + group.reclaimedAtExit) throw new Error("Open/close/exit balance failed");
  const processSamples = census.filter(row => row.at >= bounds.warmEnd && row.at < bounds.measuredEnd);
  const cpuBefore = new Map<string, number>(), cpuLast = new Map<string, number>();
  for (const sample of census) {
    if (sample.at >= bounds.measuredEnd) break;
    for (const process of sample.processes) {
      const identity = `${process.pid}:${process.start}`;
      if (sample.at < bounds.warmEnd) cpuBefore.set(identity, process.cpuTicks);
      else cpuLast.set(identity, process.cpuTicks);
    }
  }
  const resources = lines<{ at: number; phase: string; cpu: { user: number; system: number }; rss: number; loopP50: number; loopP95: number; loopP99: number; loopMax: number }>(root, "viewer.ndjson").filter(row => row.phase === "measured");
  const loop = resources.at(-1);
  const finalCensus = census.at(-1)?.processes ?? [];
  const max = (values: number[]) => Math.max(0, ...values);
  return {
    ...summary,
    runtime: fs.existsSync(path.join(root, "runtime.json"))
      ? read<{ bunVersion: string; quotaHierarchyLeafFirst: Record<string, string>[] }>(root, "runtime.json") : null,
    unfinishedViewerCallsAtTeardown: [...unfinished.values()].filter(event => event.pid === viewer).length,
    unfinishedExecutorCallsAtTeardown: [...unfinished.values()].filter(event => executors.has(event.pid)).length,
    unfinishedAdapterCallsAtTeardown: [...unfinished.values()].filter(event => event.pid !== viewer && !executors.has(event.pid)).length,
    sql: {
      measurementSeconds: bounds.seconds, measuredByDatabase: byDatabase,
      connections: [...counts.values()].map(({ lifetimeMs, current, ...group }) => ({ ...group, liveAtExit: current, currentAfterTeardown: 0, lifetimeMs: distribution(lifetimeMs) })),
      phases: Object.fromEntries(phases), commitKinds,
      commits, commitsPerSecond: commits / bounds.seconds, opensPerSecond: opens / bounds.seconds,
      zeroChangedCommits, committedChanges, failedOpens, busyResults, busyHandlerSleeps, busyHandlerWaitMs,
      contentionCalls: affectedCalls.size, contentionPer10000Completed: affectedCalls.size * 10_000 / summary.completed,
      applicationWaitMs, heldLeaseRefusals, leaseSqlRefusals, leaseRetryWaitMs,
      leaseAcquisitionMs: distribution(leaseAcquisitionMs),
      leaseHoldMs: distribution(holds), unreleasedLeases: leases.size, staleLeaseRemovals, unobservedLeaseRemovals,
    },
    processes: {
      peak: max(census.map(row => row.processes.length)),
      births: new Set([...registeredProcesses, ...census.flatMap(row => row.processes.map(p => `${p.pid}:${p.start}`))]).size,
      censusBirths: new Set(census.flatMap(row => row.processes.map(p => `${p.pid}:${p.start}`))).size,
      runtimeRegistrations: registeredProcesses.size, survivors: teardown.length,
      peakMainDescriptors: max(census.map(row => sum(row.processes.map(p => p.main)))),
      peakAdapterDescriptors: max(census.map(row => sum(row.processes.filter(p => role(p.pid) === "adapter").map(p => p.main)))),
      peakWalDescriptors: max(census.map(row => sum(row.processes.map(p => p.wal)))),
      peakShmDescriptors: max(census.map(row => sum(row.processes.map(p => p.shm)))),
      idleMainDescriptors: sum(finalCensus.map(p => p.main)), postTeardownMainDescriptors: 0,
      measuredPeakRssPages: max(processSamples.map(row => sum(row.processes.map(p => p.rssPages)))),
      // A stopped adapter retains its last sample in the total. CPU between
      // its last 250 ms census and exit is unobserved, so this is a lower bound.
      sampledCpuTicksLowerBound: sum([...cpuLast].map(([identity, ticks]) => Math.max(0, ticks - (cpuBefore.get(identity) ?? 0)))),
    },
    viewer: loop ? { loopP50: loop.loopP50, loopP95: loop.loopP95, loopP99: loop.loopP99, loopMax: loop.loopMax,
      firstSampleAt: resources[0].at, lastSampleAt: loop.at, scheduledStartAt: bounds.warmEnd, scheduledEndAt: bounds.measuredEnd,
      completedWindow: loop.at >= bounds.measuredEnd, resetDelayMs: resources[0].at - bounds.warmEnd,
      missingTailMs: Math.max(0, bounds.measuredEnd - loop.at),
      cpuMicros: loop.cpu.user + loop.cpu.system - resources[0].cpu.user - resources[0].cpu.system, peakRss: max(resources.map(row => row.rss)) } : null,
  };
}
