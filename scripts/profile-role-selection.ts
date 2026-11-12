// Run only in a scratch export with explicit, private LLV_STATE_DIR and HOME.
import fs from "node:fs";
import path from "node:path";
import { heapStats } from "bun:jsc";
import { CORPUS_AT, CORPUS_PROJECT, corpusRule, localSelectionProvider } from "../src/lib/memory/roleSelectionCorpus.fixture";
import { roleMemoryCollection, learnedRulesSnapshot } from "../src/lib/memory/roleStore";
import { selectRoleMemory } from "../src/lib/memory/roleSelect";
import { withViewerOperation } from "../src/lib/viewerLoopMonitor";
import type { RoleMemoryScopeRow, ScopeHistoryEntry } from "../src/lib/memory/roleTypes";

if (!process.env.LLV_STATE_DIR || !process.env.HOME || !process.env.TMPDIR
  || !path.resolve(process.env.LLV_STATE_DIR).startsWith(path.resolve(process.env.TMPDIR) + path.sep)) throw Error("profile requires a private state root beneath TMPDIR");
const scopeNames = [`role:${CORPUS_PROJECT}:builder`, "role:*:builder", `project:${CORPUS_PROJECT}`, "machine",
  ...Array.from({ length: 174 }, (_, i) => `role:foreign-${i}:builder`)];
const store = roleMemoryCollection(true)!;
if (process.argv.includes("--seed")) {
  if (store.keyRangeEntries("", "\uffff", 1).length) throw Error("profile seeding requires an empty store");
  let historyBytes = 0;
  for (let i = 0; i < scopeNames.length; i++) {
    const scope = scopeNames[i];
    const count = i < 4 ? [49, 48, 48, 48][i] : i < 38 ? 6 : 5;
    const rules = Array.from({ length: count }, (_, n) => corpusRule(i * 100 + n + 1, scope));
    const bytes = i === 0 ? 50_000_000 : i < 6 ? 12_000_000 : Math.floor(140_000_000 / 172);
    const history: ScopeHistoryEntry[] = Array.from({ length: 40 }, (_, n) => ({ revision: n + 1, at: CORPUS_AT, by: "curator", pass: `fixture-${n}`, before: [], created: [], added: [], merged: [], archived: [],
      prior: [{ id: rules[0].id, version: null, fields: { kind: "rule", id: rules[0].id, scope, state: "active", source: rules[0].source,
        createdAt: CORPUS_AT, changedAt: CORPUS_AT, note: "n".repeat(Math.floor(bytes / 40)) } }] }));
    historyBytes += Buffer.byteLength(JSON.stringify(history));
    const row: RoleMemoryScopeRow = { kind: "scope", scope, revision: 40, active: rules.map(r => r.id), history };
    store.boundedPatch(64, tx => { for (const rule of rules) tx.put(rule); tx.put(row); });
  }
  console.log(JSON.stringify({ seeded: true, scopes: scopeNames.length, historyBytes, activeRules: 1097, selectedPool: 193 }));
} else {
  const selectorOnly = process.argv.includes("--selector-only");
  const prepared = selectorOnly ? learnedRulesSnapshot(CORPUS_PROJECT, "builder") : null;
  const io = () => Number(/rchar: (\d+)/.exec(fs.readFileSync("/proc/thread-self/io", "utf8"))![1]);
  const load = { rounds: 5, concurrent: 8, pool: 193, provider: "no key", heartbeatMs: 5, label: "memory.select", selectorOnly };
  const samples: unknown[] = [];
  for (let round = 0; round < load.rounds; round++) {
    let previous = performance.now(), maxGapMs = 0;
    const heartbeat = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; }, load.heartbeatMs);
    const readStart = io(), heapBefore = heapStats().heapSize, start = performance.now();
    const reads: number[] = [];
    const selections = await Promise.all(Array.from({ length: load.concurrent }, () => withViewerOperation("memory.select", async () => {
      const before = performance.now();
      const snapshot = prepared ?? learnedRulesSnapshot(CORPUS_PROJECT, "builder");
      if (snapshot.candidates.reduce((count, scope) => count + scope.rules.length, 0) !== load.pool) throw Error("profile fixture has the wrong pool; seed a fresh private store first");
      reads.push(performance.now() - before);
      return selectRoleMemory(snapshot.candidates, "Durable receipt ownership and translated amber ledger labels", { provider: localSelectionProvider, timeoutMs: 3000 });
    })));
    await new Promise(resolve => setImmediate(resolve));
    maxGapMs = Math.max(maxGapMs, performance.now() - previous);
    clearInterval(heartbeat);
    samples.push({ round, elapsedMs: performance.now() - start, readsMs: reads, maxGapMs, readBytes: io() - readStart,
      heapBefore, heapAfter: heapStats().heapSize, rss: process.memoryUsage.rss(),
      selections: selections.map(s => ({ selector: s.selector, reason: s.reason, timings: s.evidence?.timings, latencyMs: s.evidence?.latencyMs })) });
  }
  console.log(JSON.stringify({ load, samples }, null, 2));
}
