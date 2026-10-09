import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/*
 * The relay's chat conversations reach the operator and nobody else
 * (relay-slice3.md §4.6): the list route and the feed reads admit the local
 * operator, refuse an agent's capability, and serve only the transcript a
 * conversation record names. Deleting one through the feed route stays refused.
 * The single answers the install kept are listed beside them, per relay.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "relay-chats-route-"));
const OLD = { state: process.env.LLV_STATE_DIR, claude: process.env.LLV_CLAUDE_HOME };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
afterAll(() => {
  if (OLD.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD.state;
  if (OLD.claude === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD.claude;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
const { statePath } = await import("@/lib/configDir");
const { updateRelayStore } = await import("@/lib/externalRelay/store");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/capabilityHeader");
const { GET } = await import("./route");
const logs = await import("@/app/api/logs/route");
const log = await import("@/app/api/log/route");

const origin = "http://127.0.0.1:8899";
const operator = { origin, host: "127.0.0.1:8899" };
const agent = { ...operator, [VIEWER_SPAWN_CAPABILITY_HEADER]: "A".repeat(43) };
afterEach(() => setCallerConversationResolverForTests(null));
const asAgent = () => setCallerConversationResolverForTests((digest) => (digest ? "conversation_agent" : null));

const CLAUDE_ID = "11111111-2222-0333-0444-555555555555";
const CODEX_ID = "66666666-7777-0888-0999-aaaaaaaaaaaa";
const EMPTY_ID = "bbbbbbbb-cccc-0ddd-0eee-ffffffffffff";
const SESSION = "0f0e0d0c-0b0a-0908-0706-050403020100";
const THREAD = "0a0a0a0a-0000-0000-0000-000000000001";
const cwd = (id: string) => path.join("/tmp", `llv-relay-conv-${id}`);
const record = (id: string, over: Record<string, unknown>) => ({
  id, relayId: "relay_chats", targetId: "bot-1", chatKey: "chat_key_aaaaaaaaaaaa", context: "member", engine: "claude",
  sessionId: null, accountId: null, cwd: cwd(id), turns: 2, turnsSinceCompaction: 2, createdAt: "2026-10-09T08:00:00.000Z",
  lastTurnAt: "2026-10-09T08:10:00.000Z", seen: [], staticDigest: null, lastPromptTokens: null, compactions: 0, state: "idle", runningRequestId: null, ...over,
});

test("an install that never kept a chat conversation lists none and writes nothing", async () => {
  const seeded = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(SANDBOX, "untouched-state");
  try {
    const response = await GET(new NextRequest(`${origin}/api/external-relay/conversations`, { headers: operator }));
    expect(await response.json()).toEqual({ relays: [], chats: [], answers: [], retentionDays: 30 });
    expect(fs.existsSync(path.join(SANDBOX, "untouched-state", "external-relay"))).toBe(false);
  } finally { process.env.LLV_STATE_DIR = seeded; }
});

const account = createManagedClaudeAccount("Relay chats fixture");
const claudeTranscript = path.join(account.projectsDir, cwd(CLAUDE_ID).replace(/[^a-zA-Z0-9]/g, "-"), `${SESSION}.jsonl`);
const codexTranscript = path.join(statePath(`external-relay/conversations/${CODEX_ID}/codex`), "sessions", "2026", "10", "09", `rollout-2026-10-09T08-00-00-${THREAD}.jsonl`);
const LINE = JSON.stringify({ type: "user", message: { role: "user", content: "When is the meetup?" } }) + "\n";
for (const file of [claudeTranscript, codexTranscript]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, LINE); }
/* An ordinary file beside them that no record names. */
const stranger = path.join(SANDBOX, "elsewhere.jsonl");
fs.writeFileSync(stranger, LINE);

updateRelayStore((store) => ({
  ...store,
  relays: [{
    id: "relay_chats", origin: "https://relay.example", api_base: "https://relay.example/v1", name: "Example relay", description: "",
    credential: "secret_credential", owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: "2026-10-01T00:00:00.000Z", paused: true, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "bot-1", name: "Support bot", answered_by: "install", fallback: "service", enabled: true, engine: "claude", model: "opus", effort: null, project: null, concurrency: 1, hardCapMinutes: 30 }],
  }],
}));
fs.mkdirSync(statePath("external-relay"), { recursive: true });
fs.writeFileSync(statePath("external-relay/conversations.json"), JSON.stringify({ v: 1, conversations: [
  record(CLAUDE_ID, { sessionId: SESSION, lastTurnAt: "2026-10-09T09:00:00.000Z" }),
  record(CODEX_ID, { engine: "codex", context: "owner", sessionId: THREAD, chatKey: "chat_key_bbbbbbbbbbbb" }),
  record(EMPTY_ID, { chatKey: "chat_key_cccccccccccc", lastTurnAt: "2026-10-09T07:00:00.000Z" }),
] }));

const batch = (headers: Record<string, string>, paths: string[]) => logs.POST(new NextRequest(`${origin}/api/logs`, {
  method: "POST", headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ reqs: paths.map((file, index) => ({ id: `r${index}`, path: file, offset: 0 })) }),
}));

test("the operator reads each chat's conversation with its relay, target, chat and transcript, newest turn first", async () => {
  const response = await GET(new NextRequest(`${origin}/api/external-relay/conversations`, { headers: operator }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.relays).toEqual([{ id: "relay_chats", name: "Example relay", origin: "https://relay.example" }]);
  expect(body.chats.map((chat: { id: string }) => chat.id)).toEqual([CLAUDE_ID, CODEX_ID, EMPTY_ID]);
  const [claude, codex, empty] = body.chats;
  expect(claude).toMatchObject({ relayName: "Example relay", targetName: "Support bot", chatKey: "chat_key_aaaaaaaaaaaa", context: "member", engine: "claude", turns: 2 });
  expect(claude.file).toMatchObject({ path: claudeTranscript, root: "claude-projects", project: "relay-chats-relay_chats", projectName: "Example relay", engine: "claude", fmt: "claude", kind: "session", model: "opus", activity: "idle" });
  expect(codex.file).toMatchObject({ path: codexTranscript, root: "codex-sessions", engine: "codex", fmt: "codex", model: null });
  expect(codex.context).toBe("owner");
  /* A conversation whose first turn wrote nothing yet has no transcript to open. */
  expect(empty.file).toBeNull();
  /* No credential and no chat text cross this route. */
  expect(JSON.stringify(body)).not.toContain("secret_credential");
  expect(JSON.stringify(body)).not.toContain("When is the meetup?");
});

const answerRecord = (targetId: string, requestId: string, startedAt: string, over: Record<string, unknown> = {}) => ({
  v: 1, requestId, relayId: "relay_chats", targetId, targetName: null, engine: "claude", model: "opus", claimedAt: startedAt, chatKey: null, requester: null,
  admitted: true, profile: null, startedAt, finishedAt: startedAt, durationMs: 1000, state: "finished", outcome: "answered",
  answer: { action: "reply", text: "Thursday at 18:30.", reply_to: "m1" }, delivery: "accepted",
  input: { conversation: [{ id: "m1", text: "When is the meetup?" }], respond_to: "m1" }, ...over,
});
function keepAnswer(record: ReturnType<typeof answerRecord>) {
  const directory = statePath(`external-relay/answers/${record.relayId}/${record.targetId}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${Date.parse(record.startedAt)}_${record.requestId}.json`), JSON.stringify(record));
}

test("an install whose chats hold no conversation lists its kept answers under their relay, newest first, across targets", async () => {
  const seeded = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(SANDBOX, "answers-state");
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{
        id: "relay_chats", origin: "https://relay.example", api_base: "https://relay.example/v1", name: "Example relay", description: "",
        credential: "secret_credential", owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
        pairedAt: "2026-10-01T00:00:00.000Z", paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
        targets: [{ id: "bot-1", name: "Support bot", answered_by: "install", fallback: "service", enabled: true, engine: "claude", model: "opus", effort: null, project: null, concurrency: 1, hardCapMinutes: 30 }],
      }],
    }));
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    keepAnswer(answerRecord("bot-1", "req_old", ago(3_600_000)));
    keepAnswer(answerRecord("bot-1", "req_new", ago(60_000), { outcome: "declined:handoff", answer: { action: "handoff", text: "", reply_to: null } }));
    /* A target the service no longer lists keeps its answers readable. */
    keepAnswer(answerRecord("bot-gone", "req_mid", ago(600_000)));
    /* Past the 30 days nothing is listed. */
    keepAnswer(answerRecord("bot-1", "req_expired", ago(40 * 86_400_000)));
    const response = await GET(new NextRequest(`${origin}/api/external-relay/conversations`, { headers: operator }));
    const body = await response.json();
    expect(body.chats).toEqual([]);
    expect(body.retentionDays).toBe(30);
    expect(body.answers.map((row: { requestId: string; targetId: string; targetName: string | null }) => [row.requestId, row.targetId, row.targetName])).toEqual([
      ["req_new", "bot-1", "Support bot"], ["req_mid", "bot-gone", null], ["req_old", "bot-1", "Support bot"],
    ]);
    expect(body.answers[0]).toMatchObject({ relayId: "relay_chats", state: "finished", outcome: "declined:handoff", delivery: "accepted", request: "When is the meetup?", answer: null });
    expect(JSON.stringify(body)).not.toContain("secret_credential");

    /* A new record in a target's directory is listed on the next read. */
    keepAnswer(answerRecord("bot-1", "req_newest", ago(1_000), { state: "running", outcome: null, finishedAt: null, durationMs: null, answer: null, delivery: null }));
    const again = await (await GET(new NextRequest(`${origin}/api/external-relay/conversations`, { headers: operator }))).json();
    expect(again.answers[0]).toMatchObject({ requestId: "req_newest", state: "running", outcome: null });
  } finally { process.env.LLV_STATE_DIR = seeded; }
});

test("an agent's capability is refused the list", async () => {
  asAgent();
  const response = await GET(new NextRequest(`${origin}/api/external-relay/conversations`, { headers: agent }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "operator_only" });
});

test("the feed serves a recorded relay transcript to the operator alone, and only that file", async () => {
  const read = await (await batch(operator, [claudeTranscript, codexTranscript, stranger])).json();
  expect(read.chunks.r0.data).toBe(LINE);
  expect(read.chunks.r1.data).toBe(LINE);
  expect(read.chunks.r2).toEqual({ error: "path not allowed" });

  const tail = await log.GET(new NextRequest(`${origin}/api/log?path=${encodeURIComponent(claudeTranscript)}`, { headers: operator }));
  expect((await tail.json()).data).toBe(LINE);
  const older = await log.GET(new NextRequest(`${origin}/api/log?path=${encodeURIComponent(claudeTranscript)}&before=${LINE.length}`, { headers: operator }));
  expect((await older.json()).data).toBe(LINE);

  asAgent();
  const refused = await (await batch(agent, [claudeTranscript, codexTranscript])).json();
  expect(refused.chunks).toEqual({ r0: { error: "path not allowed" }, r1: { error: "path not allowed" } });
  expect((await log.GET(new NextRequest(`${origin}/api/log?path=${encodeURIComponent(claudeTranscript)}`, { headers: agent }))).status).toBe(403);
  expect((await log.GET(new NextRequest(`${origin}/api/log?path=${encodeURIComponent(claudeTranscript)}&before=10`, { headers: agent }))).status).toBe(403);
});

test("a cross-origin page is refused the transcript, and nobody can delete it through the feed route", async () => {
  const foreign = await (await batch({ origin: "https://elsewhere.example", host: "127.0.0.1:8899" }, [claudeTranscript])).json();
  expect(foreign.chunks.r0).toEqual({ error: "path not allowed" });
  const removal = await log.DELETE(new NextRequest(`${origin}/api/log?path=${encodeURIComponent(claudeTranscript)}`, { method: "DELETE", headers: operator }));
  expect(removal.status).toBe(403);
  expect(fs.existsSync(claudeTranscript)).toBe(true);
});
