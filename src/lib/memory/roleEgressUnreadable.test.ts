import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* A role memory that exists and cannot be read names no lesson to look for,
   so every check that keeps lessons on this machine refuses instead of
   passing text through unchecked; a store never created refuses nothing.
   Each probe runs in a fresh process over a private state directory, as the
   Viewer, the MCP server and an agent's hook would after the damage. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-unreadable-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const RULE = "When a change adds a branch for empty or missing input, write the test for that branch in the same commit.";
const WHY = "Review failed on an untested empty-input path in the parser.";
const GATE = path.resolve(import.meta.dir, "../../../scripts/privacy-publication-gate.ts");

function probe(state: string, body: string): Record<string, unknown> {
  const script = path.join(sandbox, `probe-${crypto.randomUUID()}.ts`);
  fs.writeFileSync(script, `const out: Record<string, unknown> = {};\nconst attempt = async (name: string, run: () => unknown) => { try { out[name] = { ok: await run() }; } catch (error) { out[name] = { code: (error as { code?: string }).code ?? null, message: error instanceof Error ? error.message : String(error) }; } };\n${body}\nconsole.log(JSON.stringify(out));\n`);
  const result = spawnSync(process.execPath, [script], { cwd: path.resolve(import.meta.dir, "../../.."), encoding: "utf8", env: { ...process.env, LLV_STATE_DIR: state, NODE_ENV: "test" } });
  if (result.status !== 0) throw new Error(`probe failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

const STORE = `
const store = await import("${path.resolve(import.meta.dir, "roleStore.ts")}");
const feed = await import("${path.resolve(import.meta.dir, "../links/taskFeed.ts")}");
const identity = await import("${path.resolve(import.meta.dir, "../git/agentPublicationIdentity.ts")}");
const quoted = ${JSON.stringify(`Applied: ${RULE}`)};
await attempt("withheld", () => store.withoutStoredLessons(quoted));
await attempt("texts", () => store.storedLessonTexts());
await attempt("task", () => feed.outboundTask({ id: "t", project: "p", text: "Fix the parser", details: quoted }).details);
await attempt("publication", () => store.lessonPublicationEnv());
const agent = identity.agentPublicationIdentityEnv({});
out.agentFile = agent.LLV_PRIVACY_KNOWN_VALUES_FILE ?? null;
out.agentFileExists = Boolean(agent.LLV_PRIVACY_KNOWN_VALUES_FILE) && (await import("node:fs")).existsSync(agent.LLV_PRIVACY_KNOWN_VALUES_FILE);
/* A manager's bridge report, with the production deny list. */
const { viewerMcpBindings } = await import("${path.resolve(import.meta.dir, "../mcp/bindings.ts")}");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("${path.resolve(import.meta.dir, "../mcp/server.ts")}");
const control = { get: async () => ({ chats: [] }), post: async () => { throw new Error("no Viewer writes here"); } };
const bindings = viewerMcpBindings(undefined, control, {
  callerAttribution: () => ({ kind: "manager", conversationId: "conversation_mgr", role: "orchestrator" }),
  callerProject: () => "repo-unreadable-trial",
  authorizedSeats: () => [{ conversationId: "conversation_mgr", path: null, project: "repo-unreadable-trial" }],
  operatorLocale: () => "en", operatorTimeZone: () => "Europe/Kyiv", listTaskRecords: () => [], loadTasks: () => [],
} as never);
const answer = await createMcpToolService(bindings, new MemoryMcpReceiptStore()).callTool("bridge_report", { clientRequestId: "rep-1", key: "status-1", class: "status", summary: quoted });
out.bridge = JSON.stringify(answer);
`;

function repository(): string {
  const directory = fs.mkdtempSync(path.join(sandbox, "repository-"));
  fs.writeFileSync(path.join(directory, "clean.md"), "The parser returns null for empty input.\n");
  return directory;
}
const gate = (repo: string, env: Record<string, unknown>) => spawnSync(process.execPath, [GATE, "--repository", repo, "--paths", "clean.md"], {
  cwd: repo, encoding: "utf8", env: { ...process.env, LLV_PRIVACY_KNOWN_VALUES: "", NO_COLOR: "1", ...env } as NodeJS.ProcessEnv,
});

test("a corrupt lesson row refuses the relay, the linked board, the publication and every agent push, quoting nothing", () => {
  const state = path.join(sandbox, "corrupt");
  const stored = probe(state, `
const store = await import("${path.resolve(import.meta.dir, "roleStore.ts")}");
store.recordLessonRequest({ pipelineId: "p-unreadable", stageId: "fix", attempt: 1, project: "unreadable-trial", roleId: "builder", conversationId: "conversation_unreadable", at: "2026-10-07T12:00:00.000Z" });
await attempt("left", () => store.leaveLessons({ request: { pipelineId: "p-unreadable", stageId: "fix", attempt: 1 },
  source: { project: "unreadable-trial", pipelineId: "p-unreadable", stageId: "fix", attempt: 1, roleId: "builder", fixRound: true, conversationId: "conversation_unreadable" },
  lessons: [{ scope: "role", rule: ${JSON.stringify(RULE)}, why: ${JSON.stringify(WHY)} }], none: null }).left.length);
`);
  expect(stored.left).toEqual({ ok: 1 });
  const database = new Database(path.join(state, "state.sqlite"));
  /* The rule text survives in the row, so a check that fell back to it would pass. */
  const changed = database.query("UPDATE state_rows SET value_json = ? WHERE collection = 'role_memory' AND row_key LIKE 'r:%'")
    .run(JSON.stringify({ kind: "rule", id: 7, rule: RULE }));
  database.close();
  expect(changed.changes).toBe(1);

  const out = probe(state, STORE);
  for (const name of ["withheld", "texts", "task", "publication"]) {
    expect(out[name]).toEqual({ code: "LESSON_PRIVACY_UNAVAILABLE", message: expect.stringContaining("role memory could not be read") });
    expect(JSON.stringify(out[name]).toLowerCase()).not.toContain("empty or missing input");
  }
  expect(String(out.bridge)).toContain('"ok":false');
  expect(String(out.bridge)).toContain("role memory could not be read");
  expect(String(out.bridge).toLowerCase()).not.toContain("empty or missing input");
  /* An agent launched now is handed the path, and no file is there: its pre-push gate refuses. */
  expect(out.agentFile).toBe(path.join(state, "role-memory", "known-values.txt"));
  expect(out.agentFileExists).toBe(false);
  const refused = gate(repository(), { LLV_PRIVACY_KNOWN_VALUES_FILE: out.agentFile });
  expect(refused.status).not.toBe(0);
  expect(refused.stdout).toContain("configuration_error");
}, 60_000);

test("a store never created is readable and empty: nothing is withheld and nothing is refused", () => {
  const state = path.join(sandbox, "empty");
  const out = probe(state, STORE);
  expect(out.withheld).toEqual({ ok: `Applied: ${RULE}` });
  expect(out.texts).toEqual({ ok: [] });
  expect(out.publication).toEqual({ ok: { LLV_PRIVACY_KNOWN_VALUES_FILE: path.join(state, "role-memory", "known-values.txt") } });
  expect(out.agentFileExists).toBe(true);
  expect(String(out.bridge)).toContain('"ok":true');
  expect(gate(repository(), { LLV_PRIVACY_KNOWN_VALUES_FILE: out.agentFile }).status).toBe(0);
}, 60_000);
