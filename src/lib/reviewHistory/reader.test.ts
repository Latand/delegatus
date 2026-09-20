import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as list } from "@/app/api/review-history/route";
import { GET as detail } from "@/app/api/review-history/[id]/route";
import { GET as exported } from "@/app/api/review-history/[id]/export/route";
import { BoardSelection } from "@/lib/mcp/boardSelection";
import { compactFlow } from "./listAnswers";
import { reviewHistorySelectionSource, MAX_ROW_BYTES } from "./reader";
import { readArchiveArtifact, MAX_ARTIFACT_BYTES } from "./archiveArtifacts";
import { relayPrompt } from "./relayPrompt";
import { relayClientMessageId } from "./relayIdentity";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import type { Flow, Round } from "./types";

let directory: string;
let db: Database;
let prior: string | undefined;
const findings = "VERDICT: REQUEST_CHANGES\n\nP1: Preserve the receipt.";
function row(id = "review-a", state = "paused", project = "demo") {
  return {
    id, project, template: "implement-review-loop", cwd: path.join(directory, "repo"),
    implementerPath: path.join(directory, "transcript.jsonl"), implementerConversationId: "conversation_old",
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: "main", spec: "Review archived work", mode: "auto", roundLimit: 5,
    state, pausedState: "needs_decision", error: "Delivery unresolved", revision: 7,
    createdAt: "2026-08-10T00:00:00Z", closedAt: state === "closed" ? "2026-08-11T00:00:00Z" : null,
    hostClaim: null, targetSha: "a".repeat(40), extension: { retained: true },
    rounds: [{ n: 1, findingsPath: path.join(directory, "flows", id, "round-1-review.md"), verdict: "REQUEST_CHANGES", reviewedAt: "2026-08-10T01:00:00Z", reviewHeadSha: "a".repeat(40), startedAt: "2026-08-10T00:00:00Z", relayDeliveryAttempt: 1,
      relayPendingSettlement: { path: path.join(directory, "transcript.jsonl"), since: "2026-08-10T02:00:00Z" }, relayDelivery: null }],
  };
}
function put(value: ReturnType<typeof row>) {
  db.query("INSERT OR REPLACE INTO state_rows VALUES ('flows',?,?,1)").run(value.id, JSON.stringify(value));
}
function snapshot() {
  return JSON.stringify({ collections: db.query("SELECT * FROM state_collections").all(), rows: db.query("SELECT * FROM state_rows ORDER BY row_key").all(), changes: db.query("SELECT * FROM state_changes").all(), imports: db.query("SELECT * FROM state_imports").all(), registry: db.query("SELECT * FROM registry_rows").all() });
}
function request(suffix = "", headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/review-history${suffix}`, { headers: { host: "localhost", ...headers } });
}
const context = (id = "review-a") => ({ params: Promise.resolve({ id }) });
beforeEach(() => {
  directory = fs.mkdtempSync("/var/tmp/review-history-test-");
  prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  db = new Database(path.join(directory, "state.sqlite"));
  db.exec(`CREATE TABLE state_collections(collection TEXT PRIMARY KEY, revision INTEGER, change_floor INTEGER);
    CREATE TABLE state_rows(collection TEXT, row_key TEXT, value_json TEXT, controller_active INTEGER, PRIMARY KEY(collection,row_key));
    CREATE TABLE state_changes(collection TEXT, row_key TEXT, revision INTEGER);
    CREATE TABLE state_imports(collection TEXT, mirror_revision INTEGER);
    CREATE TABLE registry_rows(collection TEXT,row_key TEXT,value_json TEXT,PRIMARY KEY(collection,row_key));
    INSERT INTO state_collections VALUES('flows',19,0);
    INSERT INTO state_changes VALUES('flows','review-a',19);
    INSERT INTO state_imports VALUES('flows',19);
    INSERT INTO registry_rows VALUES('conversationAliases','conversation_old','"conversation_current"');`);
  put(row());
});
afterEach(() => {
  db.close();
  if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
  fs.rmSync(directory, { recursive: true, force: true });
});

test("archive GETs preserve all SQL revisions, controller flags, ownership, receipts and import metadata", async () => {
  fs.writeFileSync(path.join(directory, "flows.json"), JSON.stringify({ flows: [row("legacy-only")] }));
  const before = snapshot();
  const files = fs.readdirSync(directory);
  for (let i = 0; i < 2; i++) {
    expect((await list(request("?project=demo"))).status).toBe(200);
    const response = await detail(request(), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.label).toBe("Retired — delivery unresolved");
    expect(body.row.pausedState).toBe("needs_decision");
    expect(body.row.implementerConversationId).toBe("conversation_old");
    expect(body.conversations.implementer).toBe("conversation_current");
    expect(body.row.rounds[0].relayPendingSettlement).toBeTruthy();
    expect(body.relayOccurrences).toEqual([]);
    expect(body.currentHead).toBe("unknown");
    expect(body.mergeAuthority).toBe(false);
    expect((await exported(request(), context())).status).toBe(200);
  }
  expect(snapshot()).toBe(before);
  expect(fs.readdirSync(directory)).toEqual(files);
});

test("project list includes closed and approved history and preserves compact cursor/keyed contracts", async () => {
  put(row("review-b", "closed")); put(row("review-c", "approved")); put(row("other", "closed", "other"));
  const first = await (await list(request("?project=demo&limit=1"))).json();
  expect(first.rows[0].id).toBe("review-c"); expect(first.rows[0].roundCount).toBe(1);
  expect(first.rows[0].spec).toBeUndefined(); expect(first.total).toBe(3); expect(first.hasMore).toBe(true);
  const second = await (await list(request(`?project=demo&limit=1&cursor=${first.nextCursor}`))).json();
  expect(second.rows[0].id).toBe("review-b");
  const reset = await (await list(request(`?project=other&cursor=${first.nextCursor}`))).json();
  expect(reset.cursorReset).toBe(true); expect(reset.rows[0].id).toBe("other");
  const keyed = await (await list(request("?project=demo&ids=review-a,other"))).json();
  expect(keyed.rows.map((item: { id: string }) => item.id)).toEqual(["review-a"]);
  fs.writeFileSync(path.join(directory, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { demo: "canonical" }, displayNames: {} }));
  const aliased = await (await list(request("?project=canonical"))).json();
  expect(aliased.total).toBe(3); expect(aliased.rows[0].project).toBe("canonical");
});

test("missing and pruned artifacts stay explicit, with no fabricated provenance", async () => {
  const flow = row();
  fs.mkdirSync(path.dirname(flow.rounds[0]!.findingsPath), { recursive: true });
  fs.writeFileSync(flow.rounds[0]!.findingsPath, findings);
  expect((await (await detail(request(), context())).json()).relayOccurrences).toEqual([]);
  const settled = { ...flow, rounds: [{ ...flow.rounds[0]!, relayPendingSettlement: null, relayDelivery: { path: flow.implementerPath, deliveredAt: "2026-08-10T03:00:00Z" } }] };
  put(settled as unknown as ReturnType<typeof row>);
  const body = await (await detail(request(), context())).json();
  expect(body.artifacts[0].artifacts.findings.status).toBe("available");
  expect(body.relayOccurrences).toEqual([{ textDigest: messageTextDigest(relayPrompt(settled.rounds[0] as unknown as Round, findings)), deliveredAt: "2026-08-10T03:00:00Z", origin: "agent", senderRole: "reviewer", clientMessageId: relayClientMessageId(settled as unknown as Flow, settled.rounds[0] as unknown as Round) }]);
  fs.unlinkSync(flow.rounds[0]!.findingsPath);
  const pruned = await (await detail(request(), context())).json();
  expect(pruned.artifacts[0].artifacts.findings.status).toBe("missing"); expect(pruned.relayOccurrences).toEqual([]);
});

test("private export preserves extension data and available logs while redacting nested secrets and URLs", async () => {
  const flow = row();
  const secret = "sk-" + "synthetic".repeat(5);
  const extended = { ...flow, extension: { retained: true, token: "test-value", nested: [{ text: secret, link: "https://example.test/file?signature=private" }] } };
  put(extended as unknown as ReturnType<typeof row>);
  fs.mkdirSync(path.dirname(flow.rounds[0]!.findingsPath), { recursive: true });
  fs.writeFileSync(flow.rounds[0]!.findingsPath, `Authorization: Bearer ${secret}\n${findings}`);
  fs.writeFileSync(path.join(path.dirname(flow.rounds[0]!.findingsPath), "round-1-stdout.log"), "ordinary log");
  const response = await exported(request(), context());
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  const text = await response.text();
  expect(text).not.toContain(secret); expect(text).not.toContain("test-value"); expect(text).not.toContain("signature=private"); expect(text).not.toContain(directory);
  const body = JSON.parse(text);
  expect(body.private).toBe(true); expect(body.redacted).toBe(true); expect(body.row.extension.retained).toBe(true);
  expect(body.artifacts[0].artifacts.stdout.text).toBe("ordinary log"); expect(body.artifacts[0].artifacts.stderr.status).toBe("missing");
  for (const headers of ([{ origin: "https://example.test" }, { "sec-fetch-site": "cross-site" }, { host: "example.test" }] as Record<string, string>[])) {
    expect((await exported(request("", headers), context())).status).toBe(403);
  }
});

test("bounds reject excessive reads and artifact traversal without returning partial evidence", async () => {
  expect((await list(request())).status).toBe(400);
  expect((await list(request("?project=demo&limit=101"))).status).toBe(400);
  expect((await list(request("?project=demo&limit=NaN"))).status).toBe(400);
  expect((await detail(request(), context("missing"))).status).toBe(404);
  expect((await detail(request(), context("../outside"))).status).toBe(400);
  const flow = row();
  fs.mkdirSync(path.dirname(flow.rounds[0]!.findingsPath), { recursive: true });
  fs.writeFileSync(flow.rounds[0]!.findingsPath, "x".repeat(MAX_ARTIFACT_BYTES + 1));
  expect(readArchiveArtifact(directory, flow.id, flow.rounds[0]!.findingsPath).status).toBe("too_large");
  const outside = path.join(directory, "outside.txt"); fs.writeFileSync(outside, "private");
  const link = path.join(directory, "flows", flow.id, "link"); fs.symlinkSync(outside, link);
  expect(readArchiveArtifact(directory, flow.id, link).status).toBe("unavailable");
  expect(readArchiveArtifact(directory, flow.id, outside).status).toBe("unavailable");
  put({ ...flow, spec: "x".repeat(MAX_ROW_BYTES) });
  expect((await detail(request(), context())).status).toBe(413);
});

test("GET refuses unimported JSON and never creates or seeds state", async () => {
  const empty = path.join(directory, "empty"); process.env.LLV_STATE_DIR = empty;
  const source = reviewHistorySelectionSource(); expect(source.initialized).toBe(false); source.close();
  expect(fs.existsSync(empty)).toBe(false);
  fs.mkdirSync(empty); fs.writeFileSync(path.join(empty, "flows.json"), JSON.stringify({ flows: [row()] }));
  const before = fs.readdirSync(empty);
  for (const response of [await list(request("?project=demo")), await detail(request(), context()), await exported(request(), context())]) {
    expect(response.status).toBe(503); expect((await response.json()).error).toBe("ARCHIVE_NOT_INITIALIZED");
  }
  expect(fs.readdirSync(empty)).toEqual(before);
});

test("fresh unowned production process imports GETs without claiming ownership or initializing state", () => {
  // A nonexistent non-temp config path exercises ownership admission. The
  // probe never creates it; all actual scratch and the child's home are private.
  const config = path.join(process.cwd(), "unowned-archive-probe");
  expect(fs.existsSync(config)).toBe(false);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: config, NODE_ENV: "production", TMPDIR: directory };
  for (const key of ["LLV_STATE_DIR", "LLV_STATE_OWNER", "NEXT_PHASE", "NEXT_RUNTIME", "LLV_MODE"]) delete env[key as keyof typeof env];
  const probe = Bun.spawnSync({ cmd: [process.execPath, "-e", `
    const { NextRequest } = await import("next/server");
    const modules = await Promise.all([
      import("./src/app/api/review-history/route"),
      import("./src/app/api/review-history/[id]/route"),
      import("./src/app/api/review-history/[id]/export/route"),
    ]);
    const request = new NextRequest("http://localhost/api/review-history?project=demo", { headers: { host: "localhost" } });
    const results = [];
    for (const route of modules) results.push((await route.GET(request, {params: Promise.resolve({id: "review-a"})})).status);
    console.log(JSON.stringify({ results, owner: process.env.LLV_STATE_OWNER ?? null }));
  `], cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  expect(probe.exitCode).toBe(0);
  expect(JSON.parse(probe.stdout.toString())).toEqual({ results: [503, 503, 503], owner: null });
  expect(fs.existsSync(config)).toBe(false);
});


test("a page selects metadata and keyed rows from the same read-only snapshot", () => {
  db.exec("PRAGMA journal_mode=WAL");
  const source = reviewHistorySelectionSource();
  const selector = new BoardSelection(source.filename, "flows", { canonical: value => value, aliases: () => ({}) });
  try {
    put(row("review-z"));
    const page = selector.page(source, { project: "demo", ids: [], query: "", updatedSince: "", includeClosed: true }, null, 1, compactFlow);
    expect(page.rows.map(item => item.id)).toEqual(["review-a"]);
    expect(page.total).toBe(1); expect(page.hasMore).toBe(false);
  } finally { selector.close(); source.close(); }
});

test("legacy copied findings remain readable without rewriting their stored path", async () => {
  const flow = row();
  const copied = flow.rounds[0]!.findingsPath;
  fs.mkdirSync(path.dirname(copied), { recursive: true }); fs.writeFileSync(copied, findings);
  flow.rounds[0]!.findingsPath = path.join(directory, "old-home", ".claude", "viewer-state", "flows", flow.id, "round-1-review.md");
  const settled = { ...flow, rounds: [{ ...flow.rounds[0]!, relayDelivery: { path: flow.implementerPath, deliveredAt: "2026-08-10T03:00:00Z" } }] };
  put(settled as unknown as ReturnType<typeof row>);
  const before = snapshot();
  const body = await (await detail(request(), context())).json();
  expect(body.artifacts[0].artifacts.findings.text).toBe(findings);
  expect(body.relayOccurrences).toHaveLength(1);
  expect(snapshot()).toBe(before);
  fs.unlinkSync(copied);
  expect((await (await detail(request(), context())).json()).artifacts[0].artifacts.findings.status).toBe("missing");
});

test("compact pages honor the byte budget and advance through multibyte rows", async () => {
  for (let i = 0; i < 70; i++) put({ ...row(`large-${String(i).padStart(3, "0")}`), spec: "界".repeat(1000) });
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await (await list(request(`?project=demo&limit=100${cursor ? `&cursor=${cursor}` : ""}`))).json();
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(24_000);
    for (const item of page.rows) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
    if (page.hasMore) expect(page.nextCursor).toBeTruthy();
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(71);
});
