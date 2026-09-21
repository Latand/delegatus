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
import { flowRelayedMessageOccurrences } from "./relayProvenance";
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

test.each([
  { shape: "scalar", credential: 'synthetic ordinary value, with spaces and "quotes"' },
  { shape: "object", credential: { value: 'synthetic ordinary value with "quotes", } and ]', nested: [{ value: "synthetic ordinary nested value" }] } },
  { shape: "array", credential: ["synthetic ordinary value", { nested: ["synthetic ordinary nested value", null, true, 42] }] },
])("HTTP export redacts $shape artifact credentials while preserving raw provenance and SQL revisions", async ({ credential }) => {
  const flow = row();
  const fields = ["password", "passwd", "pwd", "api_key", "api-key", "apiKey", "cookie", "authorization", "credentials", "private_key", "token", "secret"];
  const payload = JSON.stringify({ retained: "ordinary history", ...Object.fromEntries(fields.map(key => [key, credential])) })
    .replace('"credentials"', '"creden\\u0074ials"');
  const artifactTexts = {
    findings: `${findings}\n\n${payload}`,
    output: JSON.stringify({ retained: "ordinary history", nested: { pwd: credential } }, null, 2),
    stdout: `${payload}\n${payload}\n`,
    stderr: `Diagnostic context\n\`\`\`json\n${payload}\n\`\`\`\nEnd of history`,
  };
  const settled = {
    ...flow,
    extension: { retained: true, nested: [{ pwd: credential, passwd: credential }], receiptId: "archive-receipt" },
    rounds: [{ ...flow.rounds[0]!, relayPendingSettlement: null, relayDelivery: { path: flow.implementerPath, deliveredAt: "2026-08-10T03:00:00Z" } }],
  };
  put(settled as unknown as ReturnType<typeof row>);
  const artifactDirectory = path.dirname(flow.rounds[0]!.findingsPath);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const paths = {
    findings: flow.rounds[0]!.findingsPath,
    output: path.join(artifactDirectory, "round-1-last-message.md"),
    stdout: path.join(artifactDirectory, "round-1-stdout.log"),
    stderr: path.join(artifactDirectory, "round-1-stderr.txt"),
  };
  for (const kind of Object.keys(paths) as (keyof typeof paths)[]) fs.writeFileSync(paths[kind], artifactTexts[kind]);
  const before = snapshot();
  const response = await exported(request(), context());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.private).toBe(true); expect(body.redacted).toBe(true);
  expect(JSON.stringify(body)).not.toContain("synthetic ordinary");
  for (const kind of Object.keys(paths) as (keyof typeof paths)[]) {
    const artifact = body.artifacts[0].artifacts[kind];
    expect(artifact.status).toBe("available");
    expect(artifact.text).not.toContain("synthetic ordinary");
    expect(artifact.text).toContain("ordinary history");
    const serialized = JSON.stringify(credential);
    const indented = JSON.stringify(credential, null, 2).replaceAll("\n", "\n    ");
    expect(artifact.text).toBe(artifactTexts[kind].split(serialized).join(JSON.stringify("[redacted]")).split(indented).join(JSON.stringify("[redacted]")));
    expect(fs.readFileSync(paths[kind], "utf8")).toBe(artifactTexts[kind]);
  }
  expect(body.row.extension).toEqual({ retained: true, nested: [{ pwd: "[redacted]", passwd: "[redacted]" }], receiptId: "archive-receipt" });
  expect(body.row.revision).toBe(flow.revision);
  expect(body.recorded.reviewHeadSha).toBe(flow.rounds[0]!.reviewHeadSha);
  expect(body.relayOccurrences).toEqual([{
    textDigest: messageTextDigest(relayPrompt(settled.rounds[0] as unknown as Round, artifactTexts.findings)),
    deliveredAt: "2026-08-10T03:00:00Z", origin: "agent", senderRole: "reviewer",
    clientMessageId: relayClientMessageId(settled as unknown as Flow, settled.rounds[0] as unknown as Round),
  }]);
  expect(snapshot()).toBe(before);
});

/** Exercise every artifact independently, with a settled receipt whose digest
 * must continue to describe the raw findings after either export or refusal. */
function installExportArtifacts(texts: Record<"findings" | "output" | "stdout" | "stderr", string>, extension: Record<string, unknown> = {}) {
  const flow = row();
  const settled = {
    ...flow, extension: { ...extension, receiptId: "archive-receipt" },
    rounds: [{ ...flow.rounds[0]!, relayPendingSettlement: null, relayDelivery: { path: flow.implementerPath, deliveredAt: "2026-08-10T03:00:00Z" } }],
  };
  put(settled as unknown as ReturnType<typeof row>);
  const artifactDirectory = path.dirname(flow.rounds[0]!.findingsPath);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const paths = {
    findings: flow.rounds[0]!.findingsPath,
    output: path.join(artifactDirectory, "round-1-last-message.md"),
    stdout: path.join(artifactDirectory, "round-1-stdout.log"),
    stderr: path.join(artifactDirectory, "round-1-stderr.txt"),
  };
  for (const kind of Object.keys(paths) as (keyof typeof paths)[]) fs.writeFileSync(paths[kind], texts[kind]);
  const before = snapshot();
  const occurrences = [{
    textDigest: messageTextDigest(relayPrompt(settled.rounds[0] as unknown as Round, texts.findings)),
    deliveredAt: "2026-08-10T03:00:00Z", origin: "agent" as const, senderRole: "reviewer" as const,
    clientMessageId: relayClientMessageId(settled as unknown as Flow, settled.rounds[0] as unknown as Round),
  }];
  return async () => {
    for (const kind of Object.keys(paths) as (keyof typeof paths)[]) expect(fs.readFileSync(paths[kind], "utf8")).toBe(texts[kind]);
    const stored = db.query("SELECT value_json FROM state_rows WHERE collection='flows' AND row_key=?").get(flow.id) as { value_json: string };
    const raw = JSON.parse(stored.value_json);
    expect(raw).toEqual(settled);
    expect(flowRelayedMessageOccurrences(raw.implementerPath, {
      flows: () => [raw], findings: () => fs.readFileSync(paths.findings, "utf8"),
    })).toEqual(occurrences);
    expect(snapshot()).toBe(before);
    return occurrences;
  };
}

test.each(["message", "array", "recursive"].flatMap(shape => [
  { shape, valueKind: "scalar", credential: 'invented ordinary credential with "quotes" and \\ escapes' },
  { shape, valueKind: "object", credential: { value: "invented ordinary credential", nested: ["invented ordinary credential"] } },
  { shape, valueKind: "array", credential: ["invented ordinary credential", { value: "invented ordinary credential" }] },
]))("HTTP export redacts encoded $valueKind credentials in $shape strings", async ({ shape, credential }) => {
  const payload = (value: unknown) => JSON.stringify({ retained: "ordinary history", credentials: value, password: value }).replace('"credentials"', '"creden\\u0074ials"');
  const wrap = (text: string) => {
    if (shape === "array") return JSON.stringify([text, "ordinary array text"]);
    if (shape === "recursive") text = JSON.stringify({ message: JSON.stringify({ message: text }) });
    return JSON.stringify({ message: `Diagnostic context\n\`\`\`json\n${text}\n\`\`\`\nEnd of history`, retained: "ordinary outer text" });
  };
  const encoded = wrap(payload(credential));
  const redacted = wrap(payload("[redacted]"));
  const formats = (text: string) => ({
    findings: `${findings}\n${text}`, output: text, stdout: `${text}\n${text}\n`,
    stderr: `Diagnostic context\n\`\`\`json\n${text}\n\`\`\`\nEnd of history`,
  });
  const unchanged = installExportArtifacts(formats(encoded));
  const response = await exported(request(), context());
  const bytes = await response.text();
  const occurrences = await unchanged();
  expect(response.status).toBe(200);
  expect(bytes).not.toContain("invented ordinary credential");
  const body = JSON.parse(bytes);
  expect(body.redacted).toBe(true);
  for (const [kind, text] of Object.entries(formats(redacted))) expect(body.artifacts[0].artifacts[kind].text).toBe(text);
  expect(body.row.extension.receiptId).toBe("archive-receipt");
  expect(body.relayOccurrences).toEqual(occurrences);
});

test.each(["findings", "output", "stdout", "stderr"] as const)("HTTP export refuses truncated quoted credentials in %s without changing provenance", async kind => {
  const truncated = '{"password":"invented ordinary credential';
  for (const value of [truncated, `${truncated}\\`, `${truncated}\\"`, `${truncated}\\u00`, truncated.replace('"password"', '"pass\\u0077ord"')]) {
    for (const text of [value, `{"retained":"ordinary history"}\n${value}`, `Diagnostic context\n\`\`\`json\n${value}`, JSON.stringify({ message: value })]) {
      const unchanged = installExportArtifacts({ findings, output: "ordinary output", stdout: "ordinary stdout", stderr: "ordinary stderr", [kind]: text });
      const response = await exported(request(), context());
      const bytes = await response.text();
      await unchanged();
      expect(bytes).not.toContain("invented ordinary credential");
      expect(response.status).toBe(503);
      expect(JSON.parse(bytes)).toEqual({ error: "ARCHIVE_UNAVAILABLE" });
    }
  }
});

const artifactKinds = ["findings", "output", "stdout", "stderr"] as const;
const encodeMessage = (text: string, levels: number): string => levels === 0 ? text : JSON.stringify({ message: encodeMessage(text, levels - 1) });
const artifactFormats = [
  (text: string) => text,
  (text: string) => `${text}\n${text}\n`,
  (text: string) => `Diagnostic context\n\`\`\`json\n${text}\n\`\`\`\nEnd of history`,
];

async function exportArtifact(kind: typeof artifactKinds[number], text: string, extension: Record<string, unknown> = {}) {
  const unchanged = installExportArtifacts({ findings, output: "ordinary output", stdout: "ordinary stdout", stderr: "ordinary stderr", [kind]: text }, extension);
  const response = await exported(request(), context());
  const bytes = await response.text();
  const occurrences = await unchanged();
  return { response, bytes, occurrences };
}

test.each(artifactKinds)("HTTP export refuses malformed encoded strings in %s without changing source or provenance", async kind => {
  const marker = "invented ordinary malformed value";
  const complete = JSON.stringify({ message: JSON.stringify({ password: marker, retained: "history" }) });
  const malformed = [
    complete.slice(0, complete.indexOf("history") + 3),
    complete.slice(0, -2) + '\\q"}',
    complete.slice(0, -2) + '\\u00"}',
  ];
  for (const value of malformed) for (const levels of [0, 1, 2]) for (const format of artifactFormats) {
    const { response, bytes } = await exportArtifact(kind, format(encodeMessage(value, levels)));
    expect(bytes).not.toContain(marker);
    expect(response.status).toBe(503);
    expect(JSON.parse(bytes)).toEqual({ error: "ARCHIVE_UNAVAILABLE" });
  }
});

test.each(artifactKinds)("HTTP export redacts complete decoded headers in %s and preserves ordinary history", async kind => {
  const marker = "inventedordinaryheadervalue";
  const headers = [
    `Authorization: Bearer ${marker}`,
    `Proxy-Authorization: Basic ${marker}`,
    `Cookie: session=${marker}`,
    `Set-Cookie: session=${marker}; HttpOnly`,
    `Authorization: Bearer "${marker}"`,
  ];
  for (const header of headers) for (const levels of [0, 1, 2, 3]) for (const format of artifactFormats) {
    const text = `${header}\nordinary history`;
    const expected = `${header.slice(0, header.indexOf(":") + 1)} [redacted]\nordinary history`;
    const { response, bytes, occurrences } = await exportArtifact(kind, format(encodeMessage(text, levels)));
    expect(response.status).toBe(200);
    expect(bytes).not.toContain(marker);
    const body = JSON.parse(bytes);
    expect(body.artifacts[0].artifacts[kind].text).toBe(format(encodeMessage(expected, levels)));
    expect(body.row.extension.receiptId).toBe("archive-receipt");
    expect(body.relayOccurrences).toEqual(occurrences);
  }
});

test.each(artifactKinds)("HTTP export preserves lines and nested JSON after decoded URLs in %s", async kind => {
  const text = "https://example.test/path?signature=private\nKEEP_NEXT_LINE\nEND";
  const expected = "https://example.test/path?redacted\nKEEP_NEXT_LINE\nEND";
  for (const levels of [0, 1, 2, 3]) for (const format of artifactFormats) {
    const { response, bytes, occurrences } = await exportArtifact(kind, format(encodeMessage(text, levels)));
    expect(response.status).toBe(200);
    expect(bytes).not.toContain("signature=private");
    const body = JSON.parse(bytes);
    const result = body.artifacts[0].artifacts[kind].text;
    expect(result).toBe(format(encodeMessage(expected, levels)));
    // Extract the JSON/JSONL/fenced payload and parse every encoding layer.
    let decoded = format === artifactFormats[2] ? result.split("\n")[2] : levels ? result.split("\n")[0] : result;
    for (let i = 0; i < levels; i++) decoded = JSON.parse(decoded).message;
    if (levels) expect(decoded).toBe(expected);
    expect(body.relayOccurrences).toEqual(occurrences);
  }
});

test.each(artifactKinds)("HTTP export preserves credential metadata in %s and retained extensions", async kind => {
  const metadata = { tokenCount: 42, passwordChanged: false, secretary: "ordinary history", token_count: 7, PASSWORD_CHANGED: true, secretariat: "retained history" };
  const marker = "invented ordinary classified value";
  const credentials = Object.fromEntries(["token", "credentials", "PASSWORD", "AccessToken", "client_secret", "Api-Key", "PRIVATE KEY", "proxy_authorization", "setCookie"].map(key => [key, marker]));
  const redacted = Object.fromEntries(Object.keys(credentials).map(key => [key, "[redacted]"]));
  const serialize = (values: Record<string, unknown>) => JSON.stringify({ ...metadata, ...values }).replace('"PASSWORD"', '"PASS\\u0057ORD"');
  for (const levels of [0, 1, 2, 3]) for (const format of artifactFormats) {
    const { response, bytes, occurrences } = await exportArtifact(kind, format(encodeMessage(serialize(credentials), levels)), { ...metadata, ...credentials });
    expect(response.status).toBe(200);
    expect(bytes).not.toContain(marker);
    const body = JSON.parse(bytes);
    expect(body.artifacts[0].artifacts[kind].text).toBe(format(encodeMessage(serialize(redacted), levels)));
    expect(body.row.extension).toEqual({ ...metadata, ...redacted, receiptId: "archive-receipt" });
    expect(body.relayOccurrences).toEqual(occurrences);
  }
});

test("HTTP export refuses encoded strings beyond the decoding bound", async () => {
  const credential = "invented ordinary credential";
  let text = JSON.stringify({ password: credential });
  for (let i = 0; i < 10; i++) text = JSON.stringify({ message: text });
  const unchanged = installExportArtifacts({ findings: text, output: text, stdout: text, stderr: text });
  const response = await exported(request(), context());
  const bytes = await response.text();
  await unchanged();
  expect(bytes).not.toContain("invented ordinary credential");
  expect(response.status).toBe(413);
  expect(JSON.parse(bytes)).toEqual({ error: "ARCHIVE_TOO_LARGE" });
});

test.each([
  '{"credentials":{"value":"synthetic ordinary secret"',
  '{"password":["synthetic ordinary secret"}',
])("HTTP export refuses incomplete sensitive compound values: %s", async text => {
  const artifactPath = row().rounds[0]!.findingsPath;
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, text);
  const before = snapshot();
  const response = await exported(request(), context());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "ARCHIVE_UNAVAILABLE" });
  expect(fs.readFileSync(artifactPath, "utf8")).toBe(text);
  expect(snapshot()).toBe(before);
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
