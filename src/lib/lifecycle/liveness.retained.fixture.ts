import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSystemTime } from "bun:test";
import { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { buildPipeline, loadPipelines, savePipelines } from "@/lib/pipelines/store";
import type { CachedFileScan, FileScanSnapshot } from "@/lib/scanner/scanCache";
import type { FileEntry } from "@/lib/types";
import { describe } from "@/lib/scanner/describe";
import { productionLivenessSources } from "./liveness";

/** Production readers over retained cold history, with one real transcript and
 * a host owned by this test process. No runtime host is started or stopped. */
export function retainedLivenessFixture(count = 120) {
  setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-retained-"));
  const previousCodexHome = process.env.LLV_CODEX_HOME;
  process.env.LLV_CODEX_HOME = directory;
  const previousPipelines = loadPipelines();
  let registry: AgentRegistry | undefined;
  let peer: SqliteAgentRegistryStore | undefined;
  const close = () => {
    setAgentRegistryForTests(null);
    registry?.close();
    peer?.close();
    savePipelines(previousPipelines);
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
    else process.env.LLV_CODEX_HOME = previousCodexHome;
    setSystemTime();
  };
  try {
    const dataset = buildRegistryPerformanceDataset(directory, {
      ...scaledRegistryPerformanceShape(0.01), conversations: count, entries: count,
      receipts: count, activeEntries: 0, workers: 1, transcripts: 1,
      hotTerminalRows: 0, outstandingReceipts: 0, pendingDeliveries: 0,
      uncertainDeliveries: 0, grantEvery: 1,
    }, { sessionsRoot: path.join(directory, "sessions") });
    peer = new SqliteAgentRegistryStore(dataset.filename, { normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("retained dataset must already be initialized"); } });
    const worker = dataset.workers[0]!;
    const conversationId = dataset.conversations[0]!.conversationId as `conversation_${string}`;
    peer.mutate(file => {
      file.entries[worker.key]!.structuredHost!.process = captureProcessIdentity(process.pid);
    });
    const payloadReads = new Map<string, number>();
    registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
      sqliteMode: "sqlite", sqliteFilename: dataset.filename,
      onSqliteRowPayloadRead: (collection, n) => payloadReads.set(collection, (payloadReads.get(collection) ?? 0) + n),
    });
    setAgentRegistryForTests(registry);
    const pipeline = buildPipeline({ id: "retained-liveness", task: "Retained liveness", project: "fixture",
      repoDir: "/repo", srcPath: null, srcConversationId: null, now: new Date().toISOString(), stages: [
        { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Fixture", next: null,
          effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: "Fixture" } },
      ] });
    pipeline.state = "running";
    pipeline.runs[0]!.attempts.push({ n: 1, state: "running", effectiveRole: pipeline.stages[0]!.effectiveRole!, launchId: null, conversationId,
      sessionId: worker.sessionId, agentPath: worker.transcript, paneId: null, flowId: null,
      startedAt: new Date().toISOString(), completedAt: null, input: null, activatedBy: null,
      output: null, verdict: null, error: null });
    savePipelines([...previousPipelines, pipeline]);
    fs.utimesSync(worker.transcript, new Date(), new Date());
    const stat = fs.statSync(worker.transcript);
    const files: FileEntry[] = [{ ...describe("codex-sessions", path.join(directory, "sessions"), worker.transcript, stat),
      conversationId, project: "fixture", title: "Retained liveness", activity: "live" }];
    let cacheStatus: CachedFileScan["cacheStatus"] = "hit";
    const completedFileScan = async (): Promise<CachedFileScan> => ({
      snapshot: structuredClone({ files, projectCatalog: [], complete: true } as FileScanSnapshot),
      generation: 1, targetGeneration: 1, cacheStatus, requestCount: 1, cloneDurationMs: 0,
    });
    const sources = productionLivenessSources({ completedFileScan });
    registry.readOnlySnapshot();
    payloadReads.clear();
    return { directory, dataset, registry, peer, worker, conversationId, pipeline, files, sources,
      payloadReads, completedFileScan, setCacheStatus: (value: typeof cacheStatus) => { cacheStatus = value; }, close };
  } catch (error) { close(); throw error; }
}
