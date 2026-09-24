import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/runtime/deployments/route";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { viewerDeploymentSummary } from "@/lib/runtime/contracts";
import { newestDeploymentsFirst, compactDeployment } from "@/lib/mcp/compactAnswers";
import { DEPLOYMENT_LIST_STARTED_AT, RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { PreserializedJson } from "./preserializedJson";
import { serveRuntimeHost } from "./socket";

function deployment(id: string, createdAt = "2026-09-20T12:00:00.000Z"): ViewerDeploymentStatus {
  return {
    deploymentId: id, idempotencyKey: id, requestedRevision: "a".repeat(40), revision: "a".repeat(40),
    phase: "succeeded", terminal: true, candidate: null, previous: null,
    mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
    health: [], error: null, owner: { pid: 1, startIdentity: null }, createdAt, updatedAt: createdAt, revisionNumber: 1,
  };
}

function seed(journal: RuntimeJournal, count = 3) {
  const db = (journal as unknown as { db: Database }).db;
  const insert = db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq,updated_at) VALUES (?, ?, 1, ?, ?, 1)");
  for (let i = 0; i < count; i++) {
    const row = deployment(`deployment-${String(i).padStart(4, "0")}`);
    insert.run("deployment", row.deploymentId, JSON.stringify(row), i + 1);
  }
  insert.run("session", "session-large", JSON.stringify({ conversationId: "session-large", host: "hosted", turn: "running",
    voiceDeliveries: [{ deliveryId: "voice-1", responses: [{ responseId: "response-1", text: "Synthetic runtime transcript. ".repeat(400_000) }] }], recentReceipts: [] }), count + 1);
  return db;
}

test("HTTP deployment list fetches a bounded wire payload despite a large session", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-list-"));
  const socketPath = path.join(directory, "host.sock");
  const journal = new RuntimeJournal(":memory:");
  seed(journal);
  const host = new RuntimeHost(journal);
  const beforeWireBytes = Buffer.byteLength(`{"id":"${"x".repeat(36)}","ok":true,"result":${journal.snapshotJson()}}\n`);
  let wireBytes = 0;
  const methods: string[] = [];
  const server = serveRuntimeHost(socketPath, { handle: async (request) => {
    methods.push(request.method);
    const response = await host.handle(request);
    wireBytes += Buffer.byteLength(response.result instanceof PreserializedJson
      ? `{"id":"${response.id}","ok":true,"result":${response.result.json}}\n`
      : JSON.stringify(response) + "\n");
    return response;
  } });
  const previous = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  try {
    const response = await GET(new NextRequest("http://localhost/api/runtime/deployments?limit=1"));
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer.deployments.map((row: ViewerDeploymentStatus) => row.deploymentId)).toEqual(["deployment-0002"]);
    console.log(JSON.stringify({ profile: "deployment-list-wire", beforeWireBytes, wireBytes, responseBytes: Buffer.byteLength(JSON.stringify(answer)), methods }));
    expect(wireBytes).toBeLessThan(64 * 1024);
    expect(methods).toEqual(["viewer-deployment-list"]);
    const next = await GET(new NextRequest(`http://localhost/api/runtime/deployments?limit=1&compact=true&cursor=${answer.nextCursor}`));
    expect((await next.json()).deployments).toEqual([compactDeployment(deployment("deployment-0001"))]);
    const invalid = await GET(new NextRequest("http://localhost/api/runtime/deployments?cursor=invalid"));
    expect(invalid.status).toBe(400);
    expect(methods).toEqual(["viewer-deployment-list", "viewer-deployment-list"]);
  } finally {
    if (previous === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("indexed pages equal the previous answer, preserve full detail and bypass snapshots", async () => {
  const journal = new RuntimeJournal(":memory:");
  const db = seed(journal, 40);
  try {
    const before = newestDeploymentsFirst(journal.snapshot().deployments);
    const cached = journal.snapshotJson();
    const snapshot = spyOn(journal, "snapshot").mockImplementation(() => { throw new Error("snapshot selected"); });
    const snapshotJson = spyOn(journal, "snapshotJson").mockImplementation(() => { throw new Error("snapshot cache touched"); });
    const changes = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
    const host = new RuntimeHost(journal);
    const rows: unknown[] = [];
    let cursor: string | null = null;
    do {
      const response = await host.handle({ id: "page", method: "viewer-deployment-list", params: { limit: 7, ...(cursor ? { cursor } : {}) } });
      expect(response.ok).toBe(true);
      const page = response.result as ReturnType<RuntimeJournal["listViewerDeployments"]>;
      expect(page.deployments.length).toBeLessThanOrEqual(7);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      rows.push(...page.deployments);
      cursor = page.nextCursor;
    } while (cursor);
    expect(rows).toEqual(before);
    expect(journal.listViewerDeployments({ limit: 0 }).deployments).toEqual(before.slice(0, 1));
    expect(journal.listViewerDeployments().deployments).toEqual(before.slice(0, 25));
    expect(journal.listViewerDeployments({ limit: 1, compact: true }).deployments).toEqual([compactDeployment(before[0]!)]);
    expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(changes);
    expect(snapshot).not.toHaveBeenCalled();
    expect(snapshotJson).not.toHaveBeenCalled();
    snapshot.mockRestore();
    snapshotJson.mockRestore();
    expect(journal.snapshotJson()).toBe(cached);
    for (const params of [{ cursor: "broken" }, { cursor: 1 }, { limit: "10" }, { compact: "yes" }]) {
      expect((await host.handle({ id: "invalid", method: "viewer-deployment-list", params })).ok).toBe(false);
    }
  } finally { journal.close(); }
});

test("SQL selection uses its recency index for both page forms and clamps at 100", () => {
  const journal = new RuntimeJournal(":memory:");
  const db = seed(journal, 240);
  try {
    const queries: string[] = [];
    const query = db.query.bind(db);
    const spy = spyOn(db, "query").mockImplementation(((sql: string) => { queries.push(sql); return query(sql); }) as typeof db.query);
    const first = journal.listViewerDeployments({ limit: 10_000 });
    expect(first.deployments).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const second = journal.listViewerDeployments({ limit: 2, cursor: first.nextCursor! });
    expect(second.deployments.map(row => row.deploymentId)).toEqual(["deployment-0139", "deployment-0138"]);
    spy.mockRestore();
    for (const sql of queries) {
      const params = sql.includes("< (?, ?)") ? [Date.parse("2026-09-20T12:00:00Z"), Date.parse("2026-09-20T12:00:00Z"), "deployment-0140", 3] : [101];
      const plan = query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes("deployment_list_recent"))).toBe(true);
      expect(plan.some(row => /TEMP B-TREE/.test(row.detail))).toBe(false);
      if (params.length > 1) expect(plan.some(row => row.detail.includes("SEARCH"))).toBe(true);
      expect(sql).not.toContain("session");
      console.log(JSON.stringify({ profile: "deployment-list-plan", cursor: params.length > 1, plan }));
    }
  } finally { journal.close(); }
});

test("ordering preserves timestamp offsets, millisecond ties and legacy timestamp fallback", () => {
  const journal = new RuntimeJournal(":memory:");
  const db = seed(journal, 4);
  try {
    const times = ["2026-09-20T13:00:00.123+01:00", "2026-09-20T12:00:00.123Z", "invalid", "invalid"];
    for (let i = 0; i < times.length; i++) {
      const row = deployment(`deployment-000${i}`, times[i]);
      if (i === 2) row.updatedAt = "2026-09-21T00:00:00.001Z";
      db.query("UPDATE entities SET state_json = ? WHERE kind = 'deployment' AND id = ?").run(JSON.stringify(row), row.deploymentId);
    }
    const expected = newestDeploymentsFirst(journal.snapshot().deployments);
    const actual: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = journal.listViewerDeployments({ limit: 1, ...(cursor ? { cursor } : {}) });
      actual.push(...page.deployments);
      cursor = page.nextCursor;
    } while (cursor);
    expect(actual).toEqual(expected);
    expect(expected.map(row => row.deploymentId)).toEqual(["deployment-0002", "deployment-0001", "deployment-0000", "deployment-0003"]);
  } finally { journal.close(); }
});

test("compact wire payload excludes large deployment evidence and matches the existing compact fields", async () => {
  const journal = new RuntimeJournal(":memory:");
  const db = seed(journal, 1);
  try {
    const row = deployment("deployment-0000");
    row.error = "🧪".repeat(200);
    row.health = [{ detail: "Synthetic evidence. ".repeat(100_000) }] as ViewerDeploymentStatus["health"];
    db.query("UPDATE entities SET state_json = ? WHERE kind = 'deployment'").run(JSON.stringify(row));
    const response = await new RuntimeHost(journal).handle({ id: "compact", method: "viewer-deployment-list", params: { compact: true, limit: 1 } });
    expect(response.ok).toBe(true);
    expect((response.result as { deployments: unknown[] }).deployments).toEqual([compactDeployment(row)]);
    expect(viewerDeploymentSummary(row)).toEqual(compactDeployment(row));
    const bytes = Buffer.byteLength(JSON.stringify(response) + "\n");
    expect(bytes).toBeLessThan(1200);
    console.log(JSON.stringify({ profile: "compact-deployment-wire", fullDeploymentBytes: Buffer.byteLength(JSON.stringify(row)), wireBytes: bytes }));
  } finally { journal.close(); }
});

test("index backfills legacy rows and stays correct for old-host writes and mutable phases", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-list-upgrade-"));
  const filename = path.join(directory, "journal.sqlite");
  let journal = new RuntimeJournal(filename);
  const db = seed(journal, 2);
  db.exec("DROP INDEX deployment_list_recent");
  journal.close();
  journal = new RuntimeJournal(filename);
  const legacy = new Database(filename);
  try {
    const updated = deployment("deployment-0000", "2026-09-19T12:00:00.123Z");
    updated.updatedAt = "2026-09-21T12:00:00.000Z";
    legacy.query("UPDATE entities SET state_json = ? WHERE kind = 'deployment' AND id = ?").run(JSON.stringify(updated), updated.deploymentId);
    expect(journal.listViewerDeployments({ limit: 1 }).deployments[0]!.deploymentId).toBe("deployment-0001");
    const indexedTime = legacy.query<{ t: number }, []>(`SELECT ${DEPLOYMENT_LIST_STARTED_AT} AS t FROM entities WHERE kind='deployment' AND id='deployment-0000'`).get()!.t;
    expect(indexedTime).toBe(Date.parse(updated.createdAt));
    // Old snapshots remain available to a previous Viewer throughout hand-over.
    expect(journal.snapshot().deployments).toContainEqual(updated);
  } finally { legacy.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
