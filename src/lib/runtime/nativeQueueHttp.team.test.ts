import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { NextRequest } from "next/server";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

/* The composer's queue route and the team (sign-in-and-team §7.1): a queued
   message is a message. In team mode it needs a member and, once the host
   admits it, is stamped with them under the key its delivered record names;
   a refused admission leaves no author and no event. The suite owns its state
   directory (AGENTS.md). */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-queue-team-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { RuntimeJournal } = await import("@/runtime-host/journal");
const { handleNativeQueue } = await import("./nativeQueueHttp");
const { nativeQueueDeliveryKey } = await import("./deliveryDedup");
const { conversationMessageSenders, messageSenders } = await import("@/lib/team");
const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
const { MEMBER_COOKIE } = await import("@/lib/team/sessions");
const { existingTeamStore, resetTeamStoreForTests, teamStore, teamStoreFile } = await import("@/lib/team/store");
type RuntimeHostClient = import("./client").RuntimeHostClient;
type NativeQueueCommand = import("./nativeQueueContracts").NativeQueueCommand;
type RuntimeJournalType = InstanceType<typeof RuntimeJournal>;

const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const conversationId = "conversation_queue_team";
const binding = { threadId: "thread-team", accountId: "account-a" };

function makeJournal(options: { session?: boolean } = {}): RuntimeJournalType {
  const journal = new RuntimeJournal(":memory:", { structuredHosts: true });
  if (options.session !== false) {
    journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
      conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
      host: "hosted", turn: "running", activeTurnId: "active-a", accountId: binding.accountId,
      capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
    } });
  }
  return journal;
}

function post(body: Record<string, unknown>, journal: RuntimeJournalType, cookie?: string, headers: Record<string, string> = {}) {
  return handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", ...(cookie ? { cookie: `${MEMBER_COOKIE}=${cookie}` } : {}), ...headers },
    body: JSON.stringify(body),
  }), {
    client: () => ({
      command: async (command: NativeQueueCommand) => journal.executeOperation(command),
      nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
    }) as unknown as RuntimeHostClient,
    enabled: () => true,
    kick: () => {},
    admitImages: () => ({ images: [], error: null }),
    storeImages: () => [],
  });
}

const add = (key: string, text: string) => ({ conversationId, idempotencyKey: key, action: "add", text, binding });
const sentEvents = () => existingTeamStore()!.events({ limit: 10, actions: ["message.sent"] });

beforeEach(() => {
  process.env.LLV_STATE_DIR = path.join(sandbox, `state-${Math.random().toString(36).slice(2)}`);
  resetTeamStoreForTests();
  setCallerConversationResolverForTests(() => "conversation_agent");
});

afterEach(() => { resetTeamStoreForTests(); setCallerConversationResolverForTests(null); });

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("without a team a queued message is admitted as before and no team file appears", async () => {
  const response = await post(add("solo-queue-1", "after this turn, rerun the gate"), makeJournal());
  expect(response.status).toBe(202);
  expect(fs.existsSync(teamStoreFile())).toBe(false);
});

test("in a team a queued message without a member session is refused before admission", async () => {
  claimInstall(teamStore(), "Mira", DESKTOP);
  const journal = makeJournal();
  const response = await post(add("anon-queue-1", "after this turn, rerun the gate"), journal);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "sign in required", code: "member_required" });
  expect(journal.nativeQueueRead(conversationId)).toEqual([]);
});

test("a member's admitted queued message names them, under the key its record carries", async () => {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP);
  const oleh = redeemJoin(store, createInvite(store, mira.member, null).code, "Oleh", DESKTOP);
  const journal = makeJournal();
  const response = await post(add("oleh-queue-1", "after this turn, rerun the gate"), journal, oleh.cookie);
  expect(response.status).toBe(202);
  const body = await response.json() as { receipt: { nativeQueue: { entryId: string; revision: number } } };
  const key = nativeQueueDeliveryKey(body.receipt.nativeQueue.entryId, body.receipt.nativeQueue.revision);
  expect(journal.nativeQueueRead(conversationId).map((entry) => entry.entryId)).toEqual([body.receipt.nativeQueue.entryId]);

  expect(messageSenders([key])[key]?.name).toBe("Oleh");
  expect(Object.keys(conversationMessageSenders(conversationId))).toEqual([key]);
  expect(sentEvents().map((event) => event.actor)).toEqual([{ kind: "member", memberId: oleh.member.id }]);

  /* A replay of the same request is the same admission: no second event. */
  const replay = await post(add("oleh-queue-1", "after this turn, rerun the gate"), journal, oleh.cookie);
  expect(replay.status).toBe(202);
  expect(sentEvents()).toHaveLength(1);
});

test("a refused queue admission leaves no author and no event", async () => {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP);
  /* No hosted session: the journal refuses the native entry. */
  const response = await post(add("mira-queue-refused", "after this turn, rerun the gate"), makeJournal({ session: false }), mira.cookie);
  expect(response.status).toBe(409);
  expect(conversationMessageSenders(conversationId)).toEqual({});
  expect(sentEvents()).toEqual([]);
});

test("an agent queued version keeps its server author across admission", async () => {
  claimInstall(teamStore(), "Mira", DESKTOP);
  const journal = makeJournal();
  const response = await post({ ...add("agent-queue-1", "continue the review"), origin: { kind: "operator" } },
    journal, undefined, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) });
  expect(response.status).toBe(202);
  expect(journal.nativeQueueRead(conversationId)[0]?.versions[0]?.origin).toMatchObject({
    kind: "agent", role: "agent", conversationId: "conversation_agent",
  });
});
