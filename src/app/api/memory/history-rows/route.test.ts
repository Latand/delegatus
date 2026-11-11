import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { drainRoleHistory, roleHistoryRowsEnabled } from "@/lib/memory/roleHistoryDrain";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import type { RoleMemoryScopeRow, ScopeHistoryEntry } from "@/lib/memory/roleTypes";
import { BACKUP_DIRECTORY } from "@/lib/state/durability";
import { GET, PUT } from "./route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-rows-route-"));
const previous = process.env.LLV_STATE_DIR, previousToken = process.env.LLV_TOKEN;
delete process.env.LLV_TOKEN;
const SCOPE = "role:history-route-fixture:builder";
let backups: string;
// Each test gets a store of its own: a store that already has history rows
// is past the point the backup guards.
beforeEach(() => {
  setCallerConversationResolverForTests(null);
  const directory = fs.mkdtempSync(path.join(root, "state-"));
  process.env.LLV_STATE_DIR = directory;
  backups = path.join(directory, BACKUP_DIRECTORY);
});
afterAll(() => {
  if (previousToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previousToken;
  setCallerConversationResolverForTests(null);
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

const URL = "http://localhost/api/memory/history-rows";
/** The operator's browser session of the store the test is on. */
const operator = () => ({ cookie: `llv_operator=${soloBrowserSession()}` });
const put = (body: unknown, headers: Record<string, string> = operator()) =>
  PUT(new NextRequest(URL, { method: "PUT", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = (headers: Record<string, string> = operator()) => GET(new NextRequest(URL, { headers }));
/** A state backup named as the product's backup pass names it. */
function backup(ageMs: number) {
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, `state-${new Date(Date.now() - ageMs).toISOString().replace(/[:.]/g, "-")}.sqlite`), "");
}
function seed() {
  const history = Array.from({ length: 40 }, (_, index): ScopeHistoryEntry => ({ revision: index + 1, at: new Date(1_760_000_000_000 + index).toISOString(), by: "agent", added: [], merged: [], archived: [] }));
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: SCOPE, revision: 40, active: [], history }] }));
}
const tail = () => (roleMemoryCollection()!.get(`s:${SCOPE}`) as RoleMemoryScopeRow).history.length;
/** One pass as the Viewer's clock runs it: only while the switch is on. */
const pass = () => drainRoleHistory({ minEntries: 1, maxEntries: 10, active: roleHistoryRowsEnabled });

test("the operator turns the drain on with a fresh backup and off again, and a pass runs only while it is on", async () => {
  seed();
  expect(await (await get()).json()).toMatchObject({ enabled: false, newestBackupAt: null });
  expect(await pass()).toBe(0);
  expect(tail()).toBe(40);
  backup(60_000);
  const on = await put({ enabled: true });
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({ enabled: true, newestBackupAt: expect.any(String) });
  expect(await pass()).toBe(4);
  expect(tail()).toBe(0);
  const off = await put({ enabled: false });
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({ enabled: false });
  roleMemoryCollection(true)!.boundedPatch(2, tx => {
    const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
    tx.put({ ...row, history: [{ revision: 41, at: new Date(1_760_000_100_000).toISOString(), by: "agent", added: [], merged: [], archived: [] }] });
  });
  expect(await pass()).toBe(0);
  expect(tail()).toBe(1);
});

test("turning the drain on without a backup from the last hour answers 409 and leaves it off", async () => {
  seed();
  for (const age of [null, 2 * 60 * 60 * 1000]) {
    if (age !== null) backup(age);
    const response = await put({ enabled: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "backup_required" });
    expect(roleHistoryRowsEnabled()).toBe(false);
  }
});

test("a caller without an operator session and an agent are refused, and a malformed body changes nothing", async () => {
  backup(60_000);
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
