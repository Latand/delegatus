import type { FileEntry } from "@/lib/types";
import type { RuntimeBus } from "@/hooks/runtimeBus";
import type { RuntimeEnvelope, RuntimeSession } from "@/components/runtime/runtimeModel";

export type IsolationMix = "quiet" | "foreign" | "sibling" | "catalog" | "mixed" | "miss";
export type IsolationCounters = {
  projectRowVisits: number;
  mappedArrays: number;
  publishedArrays: number;
  replacedRows: number;
  projectReplacedRows: number;
  dashboardFilterVisits: number;
  dashboardFilterArrays: number;
  projectArraysPublished: number;
  dashboardCommits: number;
  viewerCommits: number;
  connectionCommits: number;
  deploymentCommits: number;
  mobileFocusCommits: number;
  mobileBannerCommits: number;
  cardCommits: number;
  cardPropSample?: { ids: string[]; comparisons: number; equalProps: number; changes: Record<string, number> };
  editorCommits: number;
  seatMeasures: number;
  fieldGeometry: number;
};

export function emptyIsolationCounters(): IsolationCounters {
  return { projectRowVisits: 0, mappedArrays: 0, publishedArrays: 0, replacedRows: 0, projectReplacedRows: 0,
    dashboardFilterVisits: 0, dashboardFilterArrays: 0, projectArraysPublished: 0, dashboardCommits: 0,
    viewerCommits: 0, connectionCommits: 0, deploymentCommits: 0, mobileFocusCommits: 0, mobileBannerCommits: 0, cardCommits: 0, editorCommits: 0, seatMeasures: 0, fieldGeometry: 0 };
}

/** Build the same catalog for both bundles. One other-project runtime session has no catalog row. */
export function isolationCorpus(files: FileEntry[], openProject: string, seat: FileEntry, sibling: FileEntry) {
  const other = "isolation-other";
  const hostKinds = { codex: "codex-app-server", claude: "claude-broker", copilot: "copilot-acp", antigravity: "antigravity-acp" } as const;
  const sessions: RuntimeSession[] = [];
  const seen = new Set<string>();
  const byProject = new Map<string, number>();
  function addSession(file: FileEntry, id: string) {
    if (seen.has(id) || file.engine === "shell" || file.engine === "openclaw") return;
    seen.add(id);
    byProject.set(file.project, (byProject.get(file.project) ?? 0) + 1);
    sessions.push({ conversationId: id, sessionKey: { engine: file.engine, sessionId: id },
      hostKind: hostKinds[file.engine], host: "hosted",
      provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: null,
      turn: "idle", activeTurnId: null, parentConversationId: null, flowId: null, workflowId: null,
      cwd: "/fixture/board", artifactPath: file.path, capabilities: { steer: false, structuredAttention: true } });
  }
  for (const file of files) {
    if (file.project !== openProject) file.project = other;
    addSession(file, file.conversationId ?? file.path);
  }
  const open = byProject.get(openProject) ?? 0;
  const foreign = sessions.length - open;
  function makeRow(index: number, project: string) {
    const id = `isolation-${project}-${index}`;
    return { ...sibling, conversationId: id, name: id + ".jsonl", title: id,
      path: "/fixture/board/" + id + ".jsonl", project, parent: null, proc: null, pid: null,
      activity: "idle", authoritativeTurn: undefined, plan: null, mtime: sibling.mtime - 86_400 } satisfies FileEntry;
  }
  const background: FileEntry[] = [];
  for (let i = open; i < 1500; i++) {
    const file = makeRow(i, openProject);
    addSession(file, file.conversationId);
    files.push(file);
    background.push(file);
  }
  const foreignFile = files.length;
  const foreignIds: string[] = [];
  for (let i = foreign; i < 210; i++) {
    const file = makeRow(i, other);
    addSession(file, file.conversationId);
    if (i < 209) {
      files.push(file);
      if (i > foreign && foreignIds.length < 8) foreignIds.push(file.conversationId);
    }
  }
  const foreignSession = sessions.at(-1)!;
  const siblingIds = [sibling.conversationId!, ...files.filter(file => file.project === openProject && file.conversationId
    && file !== seat && file !== sibling && file.activity === "live").slice(0, 7).map(file => file.conversationId!)];
  // Exercise the artifact fallback, an unhosted session and a previous generation.
  const pathOnly = files[foreignFile]!;
  files[foreignFile] = { ...pathOnly, conversationId: undefined };
  const idle = sessions.find(row => row.artifactPath === pathOnly.path)!;
  idle.hostKind = "unhosted";
  idle.host = "unhosted";
  const subagent = background.at(-1)!;
  subagent.kind = "subagent";
  subagent.root = "claude-projects";
  subagent.engine = subagent.fmt = "claude";
  const child = sessions.find(row => row.artifactPath === subagent.path)!;
  child.hostKind = child.host = "unhosted";
  child.sessionKey = { ...child.sessionKey, engine: "claude" };
  foreignSession.hostKind = "claude-broker";
  foreignSession.sessionKey = { ...foreignSession.sessionKey, engine: "claude" };
  subagent.parent = foreignSession.artifactPath;
  subagent.conversationId = undefined;
  files.push({ ...sibling, path: sibling.path + ".previous", migratedTo: sibling.path, generation: 0, mtime: sibling.mtime - 86_400 });
  if (sessions.length !== 1710 || byProject.get(openProject) !== 1500
    || files.some(file => file.conversationId === foreignSession.conversationId)) throw Error("invalid isolation corpus");
  return { sessions, projectSessions: byProject.get(openProject)!, otherSessions: byProject.get(other)!, hiddenPaths: background.slice(0, 353).map(file => file.path),
    subagentPath: subagent.path, openId: seat.conversationId!, siblingId: sibling.conversationId!,
    foreignIds, missingId: foreignSession.conversationId, siblingIds, foreignFile };
}

export function installIsolationStream(corpus: ReturnType<typeof isolationCorpus>, files: FileEntry[],
  bus: Pick<RuntimeBus, "getState">, emit: (envelope: RuntimeEnvelope) => void, boardSeed: () => unknown) {
  // Phone navigation can change board preferences before the field receives focus.
  // Capture the source fixture at admission, while every viewport has the same board.
  const manifest = JSON.stringify([corpus.sessions,
    files.map(f => [f.project,f.conversationId,f.path,f.engine,f.kind,f.parent,f.mtime,f.size,f.migratedTo]), boardSeed()]);
  const fixtureDigest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest))
    .then(buffer => Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2,"0")).join(""));
  let emitted = 0;
  const reads = { catalog: 0, board: 0, snapshots: 0, presence: 0, storageHealth: 0 };
  let initialBody = "", revision = 1, routed = false;
  let admittedRows = 0;
  const API = {
    reads,
    fileProbe(method: string, query: URLSearchParams) {
      if (method === "HEAD") {
        reads.presence++;
        return new Response(null, { status:204 });
      }
      if (query.get("view") === "storage-health") {
        reads.storageHealth++;
        return Response.json({ state:"ok", since:null, freeBytes:1024 ** 3, registryIssues:[] },
          { headers:{ "cache-control":"no-store" } });
      }
      reads.catalog++;
      return undefined;
    },
    saveCatalog(body: string) { initialBody ||= body; },
    catalogSeed() {
      if (!initialBody) throw Error("no full catalog to transfer to the route");
      return { body:initialBody, targetPath:files[corpus.foreignFile]!.path };
    },
    routeCatalog() { routed = true; },
    routedRevision: () => routed ? revision : null,
    admitCatalog(rows: readonly FileEntry[]) {
      if (!admittedRows) {
        const admitted = new Set(rows.map(f => f.conversationId));
        if (!admitted.has(corpus.openId) || ![...corpus.siblingIds,...corpus.foreignIds].every(id => admitted.has(id))
          || admitted.has(corpus.missingId)) throw Error("incorrect identity join in the catalog response");
      }
      admittedRows = rows.length;
    },
    seedDigest: () => fixtureDigest,
    census: () => ({ sessions: Object.keys(bus.getState().store.sessions).length,
      connection: bus.getState().connection, openId: corpus.openId, projectSessions: corpus.projectSessions, otherSessions: corpus.otherSessions,
      files: files.length, admittedRows, reads: { ...reads }, emitted }),
    counters: emptyIsolationCounters,
    subagentPath: corpus.subagentPath,
    rootStatus(host: "dead" | "hosted") {
      const store = bus.getState().store;
      const id = corpus.missingId;
      const seq = store.cursor + 1;
      emit({ schemaVersion: 1, seq, eventId: "root-"+seq, scope: { type:"session", id },
        revision:(store.scopeHeads["session:"+id] ?? 0)+1, kind:"session-status", payload:{conversationId:id,host} });
    },
    ownReceipt() {
      const store = bus.getState().store;
      const seq = store.cursor + 1;
      const operationId = "isolation-receipt-" + seq;
      const envelope: RuntimeEnvelope = { schemaVersion: 1, seq, eventId: operationId, scope: { type: "operation", id: operationId }, revision: 1,
        kind: "receipt", payload: { conversationId: corpus.openId, operationId, idempotencyKey: operationId,
          kind: "send", status: "rejected", text: "Isolation receipt", reason: "Fixture refusal", revision: 1, at: new Date().toISOString() } };
      emit(envelope);
      if (!bus.getState().store.operations[operationId]) throw Error("own receipt was not applied");
      return envelope;
    },
    event(mix: Exclude<IsolationMix, "quiet">, index: number, lifecycleOnly = false) {
      const store = bus.getState().store;
      const seq = store.cursor + 1;
      const cycle = lifecycleOnly ? 2 : mix === "mixed" ? 6 : 4;
      const step = index % cycle;
      const round = Math.floor(index / cycle);
      const sibling = mix === "sibling" || (mix === "mixed" && (step === 3 || step === 5));
      const ids = sibling ? corpus.siblingIds : corpus.foreignIds;
      const id = mix === "miss" ? corpus.missingId : ids[round % ids.length]!;
      if (mix === "catalog") {
        const file = files[corpus.foreignFile]!;
        revision++;
        files[corpus.foreignFile] = { ...file, size: file.size + 1, mtime: file.mtime + 1 };
        emit({ schemaVersion: 1, eventId: "fixture-" + seq, seq, kind: "files.revision",
          scope: { type: "session", id }, payload: { filesRevision: store.filesRevision + 1 } });
      } else {
        const kind = step === 0 || (mix === "mixed" && step === 3) ? "turn-started"
          : step === cycle - 1 || (mix === "mixed" && step === 4) ? "turn-ended" : "delta";
        emit({ schemaVersion: 1, eventId: "fixture-" + seq, seq, kind,
          scope: { type: "session", id }, revision: (store.scopeHeads["session:" + id] ?? 0) + 1,
          occurredAt: new Date().toISOString(), payload: { conversationId: id, turnId: "fixture-turn-" + round,
            ...(kind === "delta" ? { text: "word " } : {}), ...(kind === "turn-ended" ? { outcome: "completed" } : {}) } });
      }
      if (bus.getState().store.cursor !== seq) throw Error("fixture envelope was not applied");
      emitted++;
      return seq;
    },
  };
  return API;
}

export type IsolationWindow = typeof window & {
  composerIsolation: ReturnType<typeof installIsolationStream>;
  isolationCounters?: IsolationCounters;
  __pdRecording?: boolean;
  __pdRows?: Array<{ name: string; start: number; end: number; changed: string[] }>;
};
