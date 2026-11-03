/** Protected-host inventory from the target release. No owner claim or Viewer. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { agentLivenessSnapshot, canonicalConversationId, productionLivenessSources, type AgentLivenessSources, type LivenessFlow } from "../src/lib/lifecycle/liveness";
import { describeTranscriptPath, type LivenessTranscript } from "../src/lib/lifecycle/transcript";
import { registryOwners, ownerProcessAlive } from "../src/lib/lifecycle/owners";
import { receiptProcessEvidence } from "../src/lib/agent/accountLiveness";
import { normalizeRegistry, type RegistryFile } from "../src/lib/agent/registry";
import { SqliteAgentRegistryStore, registryLivenessRows, registryHasPathIndex, registryConversationsForPath } from "../src/lib/agent/sqliteRegistryStore";
import { defaultRegistrySqliteFilename, resolveRegistryBackend } from "../src/lib/agent/registryBackendIdentity";
import { historyInputSql, historyPipelineRef, historyProjectionReady } from "../src/lib/state/historyProjection";
import { isStoredPipeline } from "../src/lib/pipelines/store";
import { isStoredFlow } from "../src/lib/flows/store";
import type { Flow } from "../src/lib/flows/types";
import type { RootKey } from "../src/lib/types";
import { catalogEntryToFileEntry } from "../src/lib/scanner/conversationCatalog";

const MAX_OUTPUT = 4 * 1024 * 1024;

/** One read transaction, including both the materialized rows and pending
 * identities. Pending updates/deletions replace their old rows only in RAM.
 * The product's compact-input query and reference query retain ordering,
 * historical exclusions, open/archive precedence and path fallback. */
export function readOnlyReferences(db: Database) {
  if (!historyProjectionReady(db)) throw new Error("history schema unavailable");
  const memory = new Database(":memory:");
  db.exec("BEGIN");
  memory.exec("BEGIN");
  try {
    const tables = {
      history_inputs: ["collection", "row_key", "row_order", "project", "state", "input"],
      history_attempts: ["collection", "row_key", "run", "attempt", "stageId", "n", "state", "historical", "conversationId", "agentPath", "paneId", "startedAt", "startedMs", "role", "providerWait"],
    };
    for (const [table, columns] of Object.entries(tables)) {
      // Never execute SQL obtained from a stored schema. A missing or changed
      // source column refuses this read; all local writes stay in :memory:.
      memory.exec(`CREATE TABLE ${table} (${columns.join(",")})`);
      const insert = memory.query(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of db.query<Record<string, string | number | null>, []>(`SELECT ${columns.join(",")} FROM ${table}`).iterate()) {
        insert.run(...columns.map(column => row[column]!));
      }
    }
    const inputs = new Map(db.query<{ row_key: string; row_order: number; input: string }, []>(
      "SELECT row_key,row_order,input FROM history_inputs WHERE collection='flows' ORDER BY row_order,row_key").all().map(row => [row.row_key, row]));
    const pending = db.query<{ collection: string; row_key: string }, []>(
      "SELECT collection,row_key FROM history_pending WHERE collection IN ('pipelines','pipelines_archive','flows') ORDER BY collection,row_key").all();
    for (const { collection, row_key: key } of pending) {
      const raw = db.query<{ value_json: string; row_order: number }, [string, string]>(
        "SELECT value_json,row_order FROM state_rows WHERE collection=? AND row_key=?").get(collection, key);
      const decoded: unknown = raw ? JSON.parse(raw.value_json) : null;
      const accepted = raw && (collection === "flows" ? isStoredFlow(decoded) : isStoredPipeline(decoded));
      const input = accepted ? db.query<{ input: string }, [string, string]>(historyInputSql(db, collection)).get(collection, key)!.input : null;
      if (collection === "flows") {
        inputs.delete(key);
        if (input && raw) inputs.set(key, { row_key: key, row_order: raw.row_order, input });
        continue;
      }
      for (const table of ["history_inputs", "history_attempts"]) memory.query(`DELETE FROM ${table} WHERE collection=? AND row_key=?`).run(collection, key);
      if (!input || !raw) continue;
      const value = decoded as { project: string; state: string };
      memory.query("INSERT INTO history_inputs VALUES (?,?,?,?,?,?)").run(collection, key, raw.row_order, value.project, value.state, input);
      memory.query(`INSERT INTO history_attempts SELECT ?,?,r.key,a.key,json_extract(r.value,'$.stageId'),
        ${["n", "state", "historical", "conversationId", "agentPath", "paneId", "startedAt"].map(field => `json_extract(a.value,'$.${field}')`).join(",")},
        NULL,json_extract(a.value,'$.role'),json_extract(a.value,'$.providerWait')
        FROM json_each(?,'$.runs') r,json_each(r.value,'$.attempts') a`).run(collection, key, input);
    }
    const flows = [...inputs.values()].sort((a, b) => a.row_order - b.row_order || a.row_key.localeCompare(b.row_key))
      .map(row => JSON.parse(row.input) as LivenessFlow);
    memory.exec("CREATE INDEX census_conversation ON history_attempts(conversationId,collection,historical); CREATE INDEX census_path ON history_attempts(agentPath,collection,historical); COMMIT");
    db.exec("COMMIT");
    return { memory, flows };
  } catch (error) {
    db.exec("ROLLBACK");
    memory.close();
    throw error;
  }
}

/** Root discovery has account-recovery side effects. A census already owns
 * the exact artifact paths, so it injects a per-artifact root into the native
 * describer. Engine attribution comes from those same durable generations;
 * headless rounds without a generation use the native header discriminator.
 * No root walk or account/credential lookup is needed. */
export function censusDescriber(registry: RegistryFile): AgentLivenessSources["describeTranscript"] {
  const engines = new Map<string, string>();
  const owned = registryLivenessRows(registry);
  for (const entry of owned.entries) if (entry.artifactPath) engines.set(entry.artifactPath, entry.key.engine);
  for (const receipt of owned.receipts) if (receipt.artifactPath) engines.set(receipt.artifactPath, receipt.engine);
  return async pathname => {
    let engine = engines.get(pathname);
    if (!engine) engine = conversationsAtPath(registry, pathname)[0]?.engine;
    if (!engine) {
      const fd = fs.openSync(pathname, "r");
      try {
        const head = Buffer.alloc(8192);
        const bytes = fs.readSync(fd, head, 0, head.length, 0);
        const first: unknown = JSON.parse(head.subarray(0, bytes).toString("utf8").split("\n")[0]!);
        if (first && typeof first === "object" && "type" in first) engine = first.type === "session_meta" ? "codex" : "claude";
      } finally { fs.closeSync(fd); }
    }
    const root: RootKey | null = engine === "codex" ? "codex-sessions" : engine === "claude" ? "claude-projects" : null;
    if (!root) return null; // Unsupported native evidence is incomplete.
    return describeTranscriptPath(pathname, { strict: true, readOnly: true,
      roots: [[root, root === "claude-projects" ? path.dirname(path.dirname(pathname)) : path.dirname(pathname)]] });
  };
}

function conversationsAtPath(registry: RegistryFile, pathname: string) {
  return registryHasPathIndex(registry) ? registryConversationsForPath(registry, pathname)
    : Object.values(registry.conversations).filter(conversation => conversation.generations.some(generation => generation.path === pathname)
      || conversation.continuityPaths?.includes(pathname));
}

export async function censusSnapshot(sources: AgentLivenessSources, registryRevision: number, targetRevision: string, remainingMs: number) {
  const registry = sources.registrySnapshot() as RegistryFile;
  const flows = sources.flows?.() ?? [];
  const candidates = registryLivenessRows(registry);
  const conversations: RegistryFile["conversations"] = {};
  const paths = [...candidates.entries.map(entry => entry.artifactPath), ...candidates.receipts.map(receipt => receipt.artifactPath),
    ...flows.flatMap(flow => flow.rounds.map(round => round.reviewerPath))];
  for (const pathname of paths) if (pathname) for (const conversation of conversationsAtPath(registry, pathname)) conversations[conversation.id] = conversation;
  for (const receipt of candidates.receipts) {
    const conversation = registry.conversations[receipt.conversationId];
    if (conversation) conversations[conversation.id] = conversation;
  }
  const recorded = registryOwners({ ...registry, conversations,
    entries: Object.fromEntries(candidates.entries.map(entry => [`${entry.key.engine}:${entry.key.sessionId}`, entry])),
    receipts: Object.fromEntries(candidates.receipts.map(receipt => [receipt.launchId, receipt])),
  }, flows, sources.probe).owners
    .filter(owner => (owner.role === "host" || owner.role === "reviewer") && ownerProcessAlive(owner, sources.probe));
  const owners = recorded.map(owner => ({ pid: owner.pid, binding: owner.binding }));
  for (const receipt of candidates.receipts) {
    const evidence = receiptProcessEvidence(receipt, sources.probe);
    if (evidence?.state === "alive" && !owners.some(owner => owner.pid === evidence.process.pid)) {
      owners.push({ pid: evidence.process.pid, binding: canonicalConversationId(registry, receipt.conversationId) });
    }
  }
  const inventory = new Map<string, LivenessTranscript>();
  const missing = new Set<string>();
  const snapshot = await agentLivenessSnapshot({ liveOnly: true, limit: 200,
    evidenceDeadlineMs: Math.max(1, remainingMs), evidenceByteBudget: 200 * 131072 }, {
    ...sources,
    selectInventory: async request => {
      for (const pathname of request.hostedPaths ?? []) {
        const entry = await sources.describeTranscript(pathname, { strict: true });
        if (entry) inventory.set(pathname, entry);
        else missing.add(pathname);
      }
      const entries = [...inventory.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
      return { entries: entries.slice(0, request.limit).map(entry => {
        if (entry.engine !== "codex" && entry.engine !== "claude") throw new Error("unsupported native evidence");
        return catalogEntryToFileEntry({
        path: entry.path, root: entry.engine === "codex" ? "codex-sessions" : "claude-projects", name: path.basename(entry.path),
        engine: entry.engine, fmt: entry.engine === "codex" ? "codex" : "claude", kind: "conversation",
        project: entry.project, title: entry.title, mtime: entry.mtimeMs / 1000, size: entry.sizeBytes ?? 0, firstPrompt: "",
      }); }), scanned: entries.length, matched: entries.length,
        hostedSeen: new Set(inventory.keys()), generation: null, cacheStatus: "hit", freshScan: false, selectionMs: 0 };
    },
  });
  const represented = new Set(snapshot.conversations.filter(row => row.host.state === "alive").map(row => row.host.pid));
  const unrepresented = owners.filter(owner => !represented.has(owner.pid));
  const folded = new Map<string, Set<number>>();
  for (const owner of owners) if (owner.binding) {
    const pids = folded.get(owner.binding) ?? new Set<number>();
    pids.add(owner.pid); folded.set(owner.binding, pids);
  }
  return {
    observedAt: snapshot.observedAt, targetRevision, registryRevision,
    conversations: snapshot.conversations.map(row => ({ conversationId: row.conversationId,
      host: row.host, turnState: row.turnState, pipeline: row.pipeline ? {
        pipelineId: row.pipeline.pipelineId, stageId: row.pipeline.stageId, attempt: row.pipeline.attempt,
      } : null, evidenceSource: row.evidenceSource })),
    selection: snapshot.selection,
    unselectedCount: Math.max(0, snapshot.selection.matched - snapshot.selection.selected),
    undescribedHostCount: missing.size + unrepresented.length,
    measurements: { owners: owners.length, foldedConversations: [...folded.values()].filter(pids => pids.size > 1).length },
  };
}

export async function runCensus(targetRevision: string, remainingMs: number, options: { registryDirectory?: string } = {}) {
  const started = performance.now();
  if (!process.env.LLV_STATE_DIR || !path.isAbsolute(process.env.LLV_STATE_DIR) || process.env.LLV_STATE_OWNER) throw new Error("explicit state without an owner required");
  if (!/^[a-f0-9]{40}$/.test(targetRevision) || !Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 30000) throw new Error("capture bound unavailable");
  const directory = process.env.LLV_STATE_DIR;
  if (!fs.statSync(directory).isDirectory()) throw new Error("state directory unavailable");
  const filename = path.join(options.registryDirectory ?? directory, "agent-registry.json");
  const backend = resolveRegistryBackend(filename);
  if (backend.mode === "off" || backend.pendingJsonImport) throw new Error("registry import required");
  const store = new SqliteAgentRegistryStore(backend.sqliteFilename ?? defaultRegistrySqliteFilename(filename), {
    readOnly: true, initialSnapshot: () => { throw new Error("registry import refused"); }, normalize: (value, mode) => normalizeRegistry(value, undefined, mode),
  });
  let db: Database | undefined;
  let references: ReturnType<typeof readOnlyReferences> | undefined;
  try {
    db = new Database(path.join(directory, "state.sqlite"), { readonly: true, strict: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
    references = readOnlyReferences(db);
    const registry = store.readOnlySnapshot();
    const sources = productionLivenessSources();
    const memory = references.memory;
    const answer = await censusSnapshot({ ...sources, registrySnapshot: () => registry.file,
      describeTranscript: censusDescriber(registry.file),
      pipelines: Object.assign(() => [], { forLiveness: async (targets: { conversationId: string | null; path: string }[]) => targets.map(target => historyPipelineRef(memory, target.conversationId, target.path)) }),
      flows: () => references!.flows as Flow[],
    }, registry.revision, targetRevision, remainingMs);
    const io = fs.readFileSync("/proc/self/io", "utf8");
    const status = fs.readFileSync("/proc/self/status", "utf8");
    return { ...answer, measurements: { ...answer.measurements, wallMs: performance.now() - started,
      rchar: Number(/^rchar:\s*(\d+)/m.exec(io)?.[1]), readBytes: Number(/^read_bytes:\s*(\d+)/m.exec(io)?.[1]),
      peakRssKiB: Number(/^VmHWM:\s*(\d+)/m.exec(status)?.[1]), loadAverage: os.loadavg() } };
  } finally { references?.memory.close(); db?.close(); store.close(); }
}

if (import.meta.main) {
  try {
    const answer = await runCensus(process.argv[2] ?? "", Number(process.argv[3]));
    const output = JSON.stringify(answer);
    if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error("census output oversized");
    process.stdout.write(output + "\n");
  } catch {
    process.stderr.write("Protected-host census unavailable\n");
    process.exitCode = 1;
  }
}
