import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { roleHistoryDrainTick, roleHistoryRowsEnabled, setRoleHistoryBackupPassForTests } from "@/lib/memory/roleHistoryDrain";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import type { RoleMemoryScopeRow, ScopeHistoryEntry } from "@/lib/memory/roleTypes";
import { BACKUP_DIRECTORY, runBackupPass } from "@/lib/state/durability";
import { GET, PUT } from "./route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-rows-route-"));
const previous = process.env.LLV_STATE_DIR, previousToken = process.env.LLV_TOKEN;
delete process.env.LLV_TOKEN;
const SCOPE = "role:history-route-fixture:builder";
let backups: string, state: string;
// Each test gets a store of its own: a store that already has history rows
// is past the point the backup guards.
beforeEach(() => {
  setCallerConversationResolverForTests(null);
  const directory = fs.mkdtempSync(path.join(root, "state-"));
  process.env.LLV_STATE_DIR = state = directory;
  backups = path.join(directory, BACKUP_DIRECTORY);
  // The product's backup pass, run in this process.
  setRoleHistoryBackupPassForTests(async () => runBackupPass(state, new Map()));
});
afterAll(() => {
  if (previousToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previousToken;
  setCallerConversationResolverForTests(null);
  setRoleHistoryBackupPassForTests(null);
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

const URL = "http://localhost/api/memory/history-rows";
/** The operator's browser session of the store the test is on. */
const operator = () => ({ cookie: `llv_operator=${soloBrowserSession()}` });
const put = (body: unknown, headers: Record<string, string> = operator()) =>
  PUT(new NextRequest(URL, { method: "PUT", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = (headers: Record<string, string> = operator()) => GET(new NextRequest(URL, { headers }));
function seed() {
  const history = Array.from({ length: 40 }, (_, index): ScopeHistoryEntry => ({ revision: index + 1, at: new Date(1_760_000_000_000 + index).toISOString(), by: "agent", added: [], merged: [], archived: [] }));
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: SCOPE, revision: 40, active: [], history }] }));
}
const tail = () => (roleMemoryCollection()!.get(`s:${SCOPE}`) as RoleMemoryScopeRow).history.length;
/** One look of the Viewer's clock: a pass only while the switch is on. */
const pass = () => roleHistoryDrainTick(async () => true, { minEntries: 1 });

test("the operator turns the drain on, which takes and names a backup, and off again; a pass runs only while it is on", async () => {
  seed();
  expect(await (await get()).json()).toMatchObject({ enabled: false, backup: null, idle: null });
  expect(await pass()).toBe(false);
  expect(tail()).toBe(40);
  const on = await put({ enabled: true });
  expect(on.status).toBe(200);
  const status = await on.json();
  const kept = path.join(backups, status.backup.name as string);
  expect(status).toMatchObject({ enabled: true, backup: { name: expect.stringMatching(/^role-memory-history-state-/), present: true, at: expect.any(String), restore: expect.stringContaining("whole state database") } });
  expect(fs.statSync(kept).size).toBeGreaterThan(0);
  expect(await pass()).toBe(true);
  expect(tail()).toBe(0);
  const off = await put({ enabled: false });
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({ enabled: false, backup: null });
  expect(fs.existsSync(kept)).toBe(false);
  roleMemoryCollection(true)!.boundedPatch(2, tx => {
    const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
    tx.put({ ...row, history: [{ revision: 41, at: new Date(1_760_000_100_000).toISOString(), by: "agent", added: [], merged: [], archived: [] }] });
  });
  expect(await pass()).toBe(false);
  expect(tail()).toBe(1);
});

test("turning the drain on when no backup can be taken answers 409 with the reason and leaves it off", async () => {
  seed();
  setRoleHistoryBackupPassForTests(async () => new Map([["state.sqlite", { state: "failed", detail: "fixture" } as const]]));
  const response = await put({ enabled: true });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "backup_required", message: expect.stringContaining("nothing was turned on"), restore: expect.stringContaining("whole state database"), backup: null });
  expect(roleHistoryRowsEnabled()).toBe(false);
  expect(tail()).toBe(40);
});

test("a caller without an operator session and an agent are refused, and a malformed body changes nothing", async () => {
  expect((await put({ enabled: true }, {})).status).toBe(403);
  expect((await put({ enabled: true }, { "sec-fetch-site": "same-origin" })).status).toBe(403);
  expect((await put({ enabled: true }, { ...operator(), origin: "https://remote.example" })).status).toBe(403);
  setCallerConversationResolverForTests(() => "conversation_one");
  const agent = { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) };
  expect((await put({ enabled: true }, agent)).status).toBe(403);
  expect((await get(agent)).status).toBe(403);
  setCallerConversationResolverForTests(null);
  expect((await put({ enabled: "yes" })).status).toBe(400);
  expect(roleHistoryRowsEnabled()).toBe(false);
});
