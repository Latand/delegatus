import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FilesResponse } from "../src/lib/types";
import type { RuntimeEvent, RuntimeSnapshot } from "../src/lib/runtime/contracts";

// Run through the gate in an export. The baseline module is exported alongside
// workspaceRoute.ts from the revision being compared (see workspace-human-routes.md).
const baselineFile = process.argv[2];
if (!baselineFile || !process.env.TMPDIR) throw new Error("provide the baseline projection module and an isolated TMPDIR");
const root = fs.mkdtempSync(path.join(process.env.TMPDIR, "workspace-benchmark-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR"]) {
  process.env[key] = path.join(root, key.toLowerCase());
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
const { teamStore, resetTeamStoreForTests } = await import("../src/lib/team/store");
const { AgentRegistry, setAgentRegistryForTests } = await import("../src/lib/agent/registry");
const { workspaceScope } = await import("../src/lib/team/workspaceAccess");
const { createWorkspace } = await import("../src/lib/team/workspaces");
const { mintSession, MEMBER_COOKIE } = await import("../src/lib/team/sessions");
const { requestWorkspaceScope, workspaceConversationResolver } = await import("../src/lib/team/workspaceRoute");
const { workspaceFiles, workspaceRuntime } = await import("../src/lib/team/workspaceProjection");
const { createWorkspaceFilesResponder } = await import("../src/lib/team/workspaceFilesResponse");
const { catalogEntryToFileEntry, replaceConversationCatalog } = await import("../src/lib/scanner/conversationCatalog");
const baseline = await import(pathToFileURL(path.resolve(baselineFile)).href) as typeof import("../src/lib/team/workspaceProjection");

try {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const store = teamStore();
  const owner = { id: "owner", role: "owner" as const, name: "Owner", status: "active" as const, color: "teal" as const, telegram: null, createdAt: at, createdBy: "claim", revokedAt: null };
  store.insertMember(owner);
  store.insertMember({ ...owner, id: "member", name: "Member", role: "member" });
  for (let i = 0; i < 8; i++) createWorkspace(store, owner, { id: `w_${i.toString(16).padStart(32, "0")}`, name: `Workspace ${i}`, projects: Array.from({ length: 8 }, (_, j) => `repo-${i * 8 + j}`) });
  store.putWorkspaceMember(`w_${"0".repeat(32)}`, "member", "member", "owner", at);
  const cookie = mintSession(store, "member", "claim", { surface: "desktop", browser: "chrome" }, now).value;
  const request = (etag?: string) => new Request("http://localhost/api/files?view=summary", { headers: { cookie: `${MEMBER_COOKIE}=${cookie}`, ...(etag ? { "if-none-match": etag } : {}) } });
  const catalog = Array.from({ length: 53_299 }, (_, i) => ({ path: path.join(root, "sessions", `${i}.jsonl`), root: "codex-sessions" as const, name: String(i), project: `repo-${i % 64}`, title: `Conversation ${i}`, firstPrompt: "Retained conversation context. ".repeat(8), engine: "codex" as const, kind: "session", fmt: "codex" as const, mtime: now / 1000, size: 4096 }));
  replaceConversationCatalog(catalog);
  const board: FilesResponse = { files: catalog.map(entry => catalogEntryToFileEntry(entry, now)), tasks: [], flows: [], workflows: [], pipelines: [], systemHealth: { tmux: { status: "healthy" } } };
  const body = JSON.stringify(board);
  const source = async (req: Request) => req.headers.get("if-none-match") === '"source"'
    ? new Response(null, { status: 304, headers: { etag: '"source"' } })
    : new Response(body, { headers: { etag: '"source"', "content-type": "application/json" } });
  const scope = workspaceScope(store, "member");
  const scopedResponse = createWorkspaceFilesResponder(source, requestWorkspaceScope);
  const after = () => undefined;
  const warm = await scopedResponse(request(), scope, after);
  const etag = warm.headers.get("etag")!;
  const scopedBytes = (await warm.arrayBuffer()).byteLength;
  // The d8c9778dc member path: strip validators, decode, filter and re-encode.
  const beforeFiles = async () => {
    const result = await source(request());
    const data = await result.json();
    const response = Response.json(workspaceFiles(requestWorkspaceScope(request())!, data));
    await response.arrayBuffer();
  };
  const afterFiles = async () => {
    const response = await scopedResponse(request(etag), requestWorkspaceScope(request())!, after);
    if (response.status !== 304) throw new Error("unchanged scoped poll did not validate");
    await response.arrayBuffer();
  };
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  setAgentRegistryForTests(registry);
  const ids = Array.from({ length: 256 }, (_, i) => {
    const receipt = registry.beginSpawn("codex", root, { project: `repo-${i % 64}`, title: `Session ${i}` });
    registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }, artifactPath: catalog[i]!.path, cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
    return receipt.conversationId;
  });
  // Only the ownership projection is measured; session payload encoding and
  // runtime-host transport are outside this harness.
  const snapshot: RuntimeSnapshot = { schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, serverTime: at, runtime: { hostEpoch: 1, health: "healthy" }, filesRevision: 1, sessions: ids.map(conversationId => ({ conversationId })) as RuntimeSnapshot["sessions"], attentions: [], recentOperations: [], edges: [], tasks: [], flows: [], workflows: [], deployments: [] };
  const events: RuntimeEvent[] = ids.map((id, i) => ({ schemaVersion: 1, seq: i + 1, eventId: `event-${i}`, scope: { type: "session", id }, revision: 1, kind: "turn-started", occurredAt: at, recordedAt: at, producer: { kind: "test" }, causationId: null, correlationId: null, payload: {} }));
  const resolve = await workspaceConversationResolver();
  const beforeEvents = async () => {
    for (const event of events) await baseline.workspaceRuntimeEvent(requestWorkspaceScope(request())!, event, () => requestWorkspaceScope(request()));
  };
  const afterEvents = async () => {
    // Match RuntimeJournal.replay's 128-event pages, rechecking each page.
    for (let offset = 0; offset < events.length; offset += 128) {
      const current = requestWorkspaceScope(request())!;
      for (const event of events.slice(offset, offset + 128)) if (event.scope.type === "session") current.access(resolve(event.scope.id));
    }
  };
  const beforeLogs = async () => { for (const row of catalog.slice(0, 64)) requestWorkspaceScope(request())!.access(resolve(row.path)); };
  const afterLogs = async () => { const current = requestWorkspaceScope(request())!; for (const row of catalog.slice(0, 64)) current.access(resolve(row.path)); };
  const oldSnapshot = await baseline.workspaceRuntime(scope, snapshot, () => requestWorkspaceScope(request()));
  const newSnapshot = await workspaceRuntime(scope, snapshot, () => requestWorkspaceScope(request()));
  if (JSON.stringify(oldSnapshot) !== JSON.stringify(newSnapshot) || newSnapshot.sessions.length !== 32) throw new Error("snapshot projections differ");
  const cases = [
    ["unchanged member poll", beforeFiles, afterFiles],
    ["snapshot ownership, 256 sessions", () => baseline.workspaceRuntime(scope, snapshot, () => requestWorkspaceScope(request())), () => workspaceRuntime(scope, snapshot, () => requestWorkspaceScope(request()))],
    ["runtime replay, 2 x 128 events", beforeEvents, afterEvents],
    ["log batch, 64 paths", beforeLogs, afterLogs],
  ] as const;
  const results = [];
  for (const [name, before, afterWork] of cases) {
    await before(); await afterWork();
    const samples: Record<string, { wallMs: number; cpuMs: number }[]> = { before: [], after: [] };
    for (let sample = 0; sample < 5; sample++) {
      for (const [side, work] of sample % 2 ? [["after", afterWork], ["before", before]] as const : [["before", before], ["after", afterWork]] as const) {
        const cpu = process.cpuUsage();
        const started = performance.now();
        for (let iteration = 0; iteration < 5; iteration++) await work();
        const used = process.cpuUsage(cpu);
        samples[side]!.push({ wallMs: (performance.now() - started) / 5, cpuMs: (used.user + used.system) / 5000 });
      }
    }
    results.push({ name, samples });
  }
  const measuredFiles = ["scripts/benchmark-workspace-projection.ts", "src/lib/team/workspaceAccess.ts", "src/lib/team/workspaceRoute.ts", "src/lib/team/workspaceProjection.ts", "src/lib/team/workspaceFilesResponse.ts", "src/lib/logTailStream.ts", "src/lib/runtime/sse.ts", "src/app/api/logs/stream/route.ts", "src/app/api/runtime/stream/route.ts"];
  const sourceHashes = Object.fromEntries(measuredFiles.map(file => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  console.log(JSON.stringify({ measuredAt: at, runtime: process.versions.bun, platform: process.platform, baselineProjection: "d8c9778dc", sourceHashes, rows: catalog.length, projects: 64, workspaces: 8, sessions: ids.length, sourceBytes: Buffer.byteLength(body), scopedBytes, samples: 5, iterations: 5, results }, null, 2));
} finally {
  setAgentRegistryForTests(null);
  resetTeamStoreForTests();
  fs.rmSync(root, { recursive: true, force: true });
}
