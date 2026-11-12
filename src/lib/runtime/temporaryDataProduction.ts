import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { pipelineRecordReader, claimAttemptRetirement } from "@/lib/pipelines/store";
import { laneFinish } from "@/lib/pipelines/laneFinish";
import { processIdentityProvenDead } from "@/lib/processIdentity";
import { readAttemptEvidenceBinding } from "./attemptEvidenceBinding";
import { readEnvelope } from "@/lib/recordedChecks/wire";
import { attemptTempJournalPath, tempSweepMode, type ProcessScan } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { discoverAttemptCopies } from "./attemptCopyDiscovery";
import { AttemptTempStore } from "./attemptTempRetention";
import { attemptReferencesClear, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./temporaryDataStore";
import { PRESERVATION_NAMES, sweepTemporaryData, TEMPORARY_DATA_RETENTION_MS, type TemporaryDataAuthority } from "./temporaryDataRetention";

const HOUR = 3600000;
// One leased helper owns these version-checked observations. The inventory
// expires them after ten minutes; the pass also bounds the retained set.
const checkoutReads: RetainedCheckoutReads = new Map();
const ownedName = /^[A-Za-z0-9_-]+$/;
const agentHash = (launchId: string) => createHash("sha256").update(launchId).digest("hex").slice(0, 32);
const lifecycleControlName = (name: string) => name.startsWith(".delegatus-trash-")
  || name.startsWith(".delegatus-sweep-") && name.endsWith(".json");
const stamp = (file: string) => {
  try { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":"); }
  catch { return "missing"; }
};
const held = (reason: string): TemporaryDataAuthority => ({ expiresAt: null, reason, revision: reason, current: () => false });
export type TemporaryRegistry = Pick<AgentRegistry, "temporaryDataFacts" | "temporaryDataReceiptKeys" | "spawnReceipt" | "spawnReceiptForHost">;

export function laneEvidenceAuthority(pipelineId: string, now: () => number): TemporaryDataAuthority {
  const reader = pipelineRecordReader(pipelineId), version = reader.version(), pipeline = reader.read();
  if (!pipeline) return held("lane-owner-missing");
  const finish = laneFinish(pipeline);
  return { expiresAt: finish.finished ? finish.expiresAt : null, reason: finish.finished ? "young" : "open-lane",
    pipelineIds: [pipelineId], revision: version, current: () => Number.isFinite(now()) && reader.version() === version };
}

function retainedTarget(row: TemporaryDataCandidate) {
  const journal = attemptTempJournalPath(row.directory);
  if (!fs.existsSync(journal)) return row.directory;
  const intent = readEnvelope(journal) as { directory?: unknown; identity?: unknown; trash?: unknown };
  if (intent.directory !== row.directory || intent.identity !== row.identity || typeof intent.trash !== "string"
    || path.dirname(intent.trash) !== path.dirname(row.directory)
    || !path.basename(intent.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)) throw new Error("journal-binding-changed");
  return intent.trash as string;
}

/** Entry status alone is insufficient: termination survivors, pending exits,
 * claims and admission all protect the data until their identities are dead. */
export function finishedAgent(facts: ReturnType<AgentRegistry["temporaryDataFacts"]>, provenDead = processIdentityProvenDead): number | null {
  const { receipt, entry } = facts;
  if (!entry || !["dead", "unhosted"].includes(entry.status) || entry.pendingAction || entry.claimOwner
    || entry.structuredTerminationSurvivors?.length || entry.pendingHostExits?.length
    || entry.structuredHost?.scope || entry.structuredHost?.memory?.unit
    || entry.structuredHost?.signalDomain && entry.structuredHost.signalDomain.retired !== true
    || receipt && !["completed", "failed", "conflicted"].includes(receipt.state)) return null;
  const domain = entry.structuredHost?.signalDomain;
  const identities = [entry.paneAgent, entry.structuredHost?.process, entry.hostExitProcess,
    entry.structuredHost?.exitProcess, ...(entry.structuredTerminationSurvivors ?? []),
    ...(entry.pendingHostExits ?? []).map(row => row.process), receipt?.admissionOwner,
    ...(domain ? [domain.monitor, domain.bubblewrap, domain.init, domain.native] : []),
    ...(receipt?.hostSetup?.processes ?? [])].filter(identity => identity !== undefined && identity !== null);
  if (identities.some(identity => !provenDead(identity))) return null;
  const ended = receipt?.hostExit?.exit?.at ?? entry.previousHostExit?.exit?.at ?? entry.updatedAt;
  const time = Date.parse(ended), updated = Date.parse(entry.updatedAt);
  return Number.isFinite(time) && Number.isFinite(updated) ? Math.max(time, updated) : null;
}

export function temporaryDataAuthority(row: TemporaryDataCandidate, registry: TemporaryRegistry, roots: Pick<AttemptTempStore, "owner" | "copy">, now = Date.now,
  lane: typeof laneEvidenceAuthority = laneEvidenceAuthority): TemporaryDataAuthority {
  if (row.kind === "lane-evidence") return lane(row.owner, now);
  const target = retainedTarget(row);
  if (row.kind === "journal") {
    const observations = (["claude", "codex", "copilot"] as const).map(engine => {
      const input = { key: { engine, sessionId: row.owner } };
      return { input, facts: registry.temporaryDataFacts(input) };
    }).filter(row => row.facts.entry);
    if (!observations.length) return held("session-owner-missing");
    const transcripts: [string, string][] = [];
    const lanes: TemporaryDataAuthority[] = [];
    const receiptObservations: { input: { launchId: string }; facts: ReturnType<AgentRegistry["temporaryDataFacts"]> }[] = [];
    for (const { facts } of observations) {
      if (finishedAgent(facts) === null) return held("live-session");
      const file = facts.entry!.artifactPath, stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) return held("transcript-missing");
      transcripts.push([file, stamp(file)]);
      for (const pipeline of facts.pipelines) lanes.push(lane(pipeline, now));
      // Journal ownership also follows its native session's launch membership.
      const receipt = registry.spawnReceiptForHost(facts.entry!.key);
      if (receipt) {
        const input = { launchId: receipt.launchId }, receiptFacts = registry.temporaryDataFacts(input);
        if (finishedAgent(receiptFacts) === null) return held("live-session");
        receiptObservations.push({ input, facts: receiptFacts });
        for (const pipeline of receiptFacts.pipelines) lanes.push(lane(pipeline, now));
      }
    }
    if (lanes.some(lane => lane.expiresAt === null)) return held("open-lane");
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile()) return held("journal-unavailable");
    const revision = JSON.stringify([observations, receiptObservations, lanes.map(lane => lane.revision)]);
    return { expiresAt: stat.mtimeMs + TEMPORARY_DATA_RETENTION_MS,
      reason: "young", revision, pipelineIds: lanes.flatMap(lane => lane.pipelineIds ?? []),
      current: () => observations.every(({ input, facts }) => JSON.stringify(registry.temporaryDataFacts(input)) === JSON.stringify(facts))
        && receiptObservations.every(({ input, facts }) => JSON.stringify(registry.temporaryDataFacts(input)) === JSON.stringify(facts))
        && transcripts.every(([file, before]) => stamp(file) === before)
        && lanes.every(lane => lane.current()) };
  }
  let launchId = row.owner;
  let manifestCurrent = () => true;
  let declaredPipeline: string | null = null;
  if (row.kind === "ownerless-copy") {
    const file = path.join(target, "manifest.json"), before = stamp(file);
    const manifest = readAttemptEvidenceBinding(file);
    if (typeof manifest.original !== "string" || typeof manifest.identity !== "string"
      || createHash("sha256").update(manifest.original).update("\0").update(manifest.identity).digest("hex") !== path.basename(row.directory)) return held("copy-binding-unknown");
    const source = roots.owner(manifest.original);
    const copy = roots.copy(row.directory);
    const fromRoot = source?.identity === manifest.identity ? source.pipelineId : null;
    const fromManifest = typeof manifest.pipelineId === "string" ? manifest.pipelineId : null;
    const knownPipelines = [...new Set([fromRoot, fromManifest, copy?.pipelineId].filter((value): value is string => !!value))];
    if (knownPipelines.length > 1) return held("copy-owner-conflict");
    declaredPipeline = knownPipelines[0] ?? null;
    if (typeof manifest.launchId === "string" && !manifest.launchId.trim()) return held("copy-owner-unknown");
    if (source?.identity === manifest.identity && !source.launchId) return held("copy-owner-unknown");
    if (copy && !copy.launchId) return held("copy-owner-unknown");
    const launchBindings = [...new Set([
      typeof manifest.launchId === "string" ? manifest.launchId : null,
      source?.identity === manifest.identity ? source.launchId : null,
      copy && copy.launchId !== "legacy" ? copy.launchId : null,
    ].filter((value): value is string => !!value))];
    if (launchBindings.length > 1) return held("copy-owner-conflict");
    launchId = launchBindings[0] ?? "";
    manifestCurrent = () => stamp(path.join(retainedTarget(row), "manifest.json")) === before
      && JSON.stringify(roots.owner(manifest.original as string)) === JSON.stringify(source)
      && JSON.stringify(roots.copy(row.directory)) === JSON.stringify(copy);
  }
  const input = { launchId }, facts = launchId ? registry.temporaryDataFacts(input) : null;
  if (facts?.receipt && finishedAgent(facts) === null) return held("live-agent");
  const pipelines = [...new Set([...(facts?.pipelines ?? []), ...(declaredPipeline ? [declaredPipeline] : [])])];
  if (pipelines.length > 1) return held("copy-owner-conflict");
  if (pipelines.length) {
    const authority = lane(pipelines[0]!, now);
    return { ...authority, current: () => authority.current() && manifestCurrent()
      && (!facts || JSON.stringify(registry.temporaryDataFacts(input)) === JSON.stringify(facts)) };
  }
  if (!facts?.receipt) {
    if (row.kind !== "ownerless-copy") return held("agent-owner-missing");
    return { expiresAt: row.adoptedAt + TEMPORARY_DATA_RETENTION_MS, reason: "adoption-grace", revision: "ownerless",
      current: () => manifestCurrent() && (!launchId || !registry.spawnReceipt(launchId)) };
  }
  const finished = finishedAgent(facts);
  return { expiresAt: finished === null ? null : finished + TEMPORARY_DATA_RETENTION_MS,
    reason: finished === null ? "live-agent" : "young", revision: JSON.stringify(facts),
    current: () => manifestCurrent() && JSON.stringify(registry.temporaryDataFacts(input)) === JSON.stringify(facts) };
}

export function discoverTemporaryData(store: TemporaryDataStore, registry: TemporaryRegistry, now: () => number, deadline: number, clock = () => performance.now(),
  directories = { evidence: statePath("evidence"), journals: statePath("structured-host-events") }) {
  const { evidence, journals } = directories;
  for (const [directory, kind] of [[evidence, "evidence"], [path.join(evidence, "agents"), "agents"],
    [path.join(evidence, "recorded-checks"), "recorded"], [path.join(evidence, "attempt-temp"), "copies"], [journals, "journals"]]) store.namespace(directory!, kind!);
  if (clock() < deadline) {
    const after = store.meta("receipt-cursor") ?? "", keys = registry.temporaryDataReceiptKeys(after);
    for (const key of keys) store.bindAgent(agentHash(key), key);
    store.setMeta("receipt-cursor", keys.length ? keys.at(-1)! : "");
  }
  let discovered = 0;
  for (const namespace of store.namespaces(now())) {
    if (clock() >= deadline) break;
    try {
      if (!fs.existsSync(namespace.directory)) { store.checkpoint({ ...namespace, cursor: "", checkedAt: now() + HOUR }); continue; }
      if (fs.realpathSync(namespace.directory) !== namespace.directory) throw new Error("indirect-namespace");
      const page = discoverAttemptCopies(namespace.directory, namespace.cursor, clock, deadline);
      for (const name of page.names) {
        if (clock() >= deadline) return discovered; // Do not advance an incomplete page.
        const directory = path.join(namespace.directory, name);
        if (PRESERVATION_NAMES.has(name) || name === ".delegatus-keep" || lifecycleControlName(name)) continue;
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) continue;
        const enqueue = (kind: string, owner = name) => { if (stat.isDirectory() && ownedName.test(name)) store.namespace(directory, kind, owner); };
        if (namespace.kind === "evidence") { if (!["agents", "recorded-checks", "attempt-temp"].includes(name)) enqueue("lane"); continue; }
        if (namespace.kind === "agents") { if (/^[a-f0-9]{32}$/.test(name)) enqueue("agent"); continue; }
        if (namespace.kind === "recorded") { enqueue("lane"); continue; }
        let kind: TemporaryDataCandidate["kind"], owner: string;
        if (namespace.kind === "lane") { kind = "lane-evidence"; owner = namespace.owner; }
        else if (namespace.kind === "agent") { kind = "agent-evidence"; owner = store.agent(namespace.owner) ?? ""; if (!owner) continue; }
        else if (namespace.kind === "journals") {
          if (!name.endsWith(".jsonl") || !stat.isFile()) continue;
          kind = "journal";
          try { owner = decodeURIComponent(name.slice(0, -6)); } catch { continue; }
        }
        else { if (!/^[a-f0-9]{64}$/.test(name) || !stat.isDirectory()) continue; kind = "ownerless-copy"; owner = name; }
        // A pending journal belongs exclusively to its original binding.
        if (fs.existsSync(attemptTempJournalPath(directory))) continue;
        store.register({ directory, kind, owner, scope: kind === "journal" ? journals : evidence,
          identity: `${stat.dev}:${stat.ino}`, adoptedAt: now(), checkedAt: 0, bytes: 0, reason: "discovered" });
        discovered++;
      }
      if (page.done && ["lane", "agent"].includes(namespace.kind)) {
        const stream = fs.opendirSync(namespace.directory);
        let empty: boolean;
        try { empty = stream.readSync() === null; } finally { stream.closeSync(); }
        const owner = namespace.kind === "lane" ? namespace.owner : store.agent(namespace.owner);
        if (empty && owner && !fs.existsSync(attemptTempJournalPath(namespace.directory))) {
          const stat = fs.lstatSync(namespace.directory);
          store.register({ directory: namespace.directory, scope: evidence,
            kind: namespace.kind === "lane" ? "lane-evidence" : "agent-evidence", owner,
            identity: `${stat.dev}:${stat.ino}`, adoptedAt: now(), checkedAt: 0, bytes: 0, reason: "empty-evidence-folder" });
        }
      }
      store.checkpoint({ ...namespace, cursor: page.done ? "" : page.cursor, checkedAt: now() + (page.done ? HOUR : 1000) });
    } catch {
      store.checkpoint({ ...namespace, checkedAt: now() + 60000 });
      store.setMeta("discovery-error", "namespace-unavailable");
    }
  }
  return discovered;
}

export async function runTemporaryDataSweep(ports: { scan: (directories: string[]) => ProcessScan }, env = process.env, deadline = Date.now() + 30000) {
  const mode = tempSweepMode(env);
  if (!mode || Date.now() >= deadline) return null;
  const store = new TemporaryDataStore(), roots = new AttemptTempStore();
  try {
    const registry = agentRegistry();
    const discovered = discoverTemporaryData(store, registry, Date.now, performance.now() + 1000);
    const report = await sweepTemporaryData(store, {
      mode, checkoutReads, budgetMs: Math.max(0, Math.min(5000, deadline - Date.now())), authority: async row => temporaryDataAuthority(row, registry, roots),
      references: async (row, target, inventory) => attemptReferencesClear(row.directory, target, ports.scan([row.directory, target]), undefined, inventory),
      onRemoved: row => { if (row.kind === "ownerless-copy") roots.forgetCopy(row.directory); },
      claim: async row => {
        const authority = temporaryDataAuthority(row, registry, roots), releases: (() => void)[] = [];
        try { for (const id of [...new Set(authority.pipelineIds)]) releases.push(await claimAttemptRetirement(id, row.directory)); }
        catch (error) { for (const release of releases.reverse()) release(); throw error; }
        return () => { for (const release of releases.reverse()) release(); };
      },
    }, roots.filename + ".sweep");
    writeJsonDurably(statePath("temporary-data-report.json"), { at: new Date().toISOString(), discovered, ...report });
    return report;
  } finally {
    while (checkoutReads.size > 128) checkoutReads.delete(checkoutReads.keys().next().value!);
    roots.close(); store.close();
  }
}
