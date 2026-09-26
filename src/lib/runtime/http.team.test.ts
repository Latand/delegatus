import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { messageSenders } from "@/lib/team";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { existingTeamStore, resetTeamStoreForTests, teamStore, teamStoreFile } from "@/lib/team/store";

import { handleRuntimeCommand, type RuntimeHttpDependencies } from "./http";

/* The composer's send route and the team (sign-in-and-team §7.1): in team
   mode a person's message needs a member and is stamped with them against the
   key the feed joins its record to; without a team nothing changes. */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "http-team-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

type HostAnswer = "admit" | "refuse";

/* `known` are the submission ids the delivery record already holds, as
   `deliveryAdmissionForKey` answers for them; everything else is fresh. */
function dependencies(enqueued: unknown[], host: HostAnswer = "admit", known: readonly string[] = []): RuntimeHttpDependencies {
  return {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    registry: () => ({
      deliveryAdmissionForKey: (_conversationId: string, key: string) => (known.includes(key)
        ? { outcome: "admitted", operationId: "op_earlier", deliveryId: "delivery_earlier", state: "delivered" }
        : { outcome: "not-executed" }),
    }) as never,
    recordOperatorActivity: () => null,
    recordOperatorRequest: () => null,
    enqueue: async (input) => {
      enqueued.push(input);
      return (host === "admit"
        ? { ok: true, structured: true, target: null, outcome: "held", operationId: `op_${enqueued.length}` }
        : { ok: false, structured: true, outcome: "failed", status: 409, error: "fixture host refused" }) as never;
    },
    retireReplySuggestions: () => ({ cleared: false, pending: false }),
  };
}

const sentEvents = () => existingTeamStore()!.events({ limit: 10, actions: ["message.sent"] });

beforeEach(() => {
  process.env.LLV_STATE_DIR = path.join(sandbox, `state-${Math.random().toString(36).slice(2)}`);
  resetTeamStoreForTests();
  setCallerConversationResolverForTests(() => "conversation_agent");
});

afterEach(() => {
  resetTeamStoreForTests();
  setCallerConversationResolverForTests(null);
});

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("without a team a send goes through as it always did and no team file appears", async () => {
  const enqueued: unknown[] = [];
  await handleRuntimeCommand(request({ conversationId: "conversation_direct", text: "ship it", idempotencyKey: "solo-send-1" }), "send", dependencies(enqueued));
  expect(enqueued).toHaveLength(1);
  expect(fs.existsSync(teamStoreFile())).toBe(false);
});

test("in a team a send without a member session is refused before it is admitted", async () => {
  claimInstall(teamStore(), "Mira", DESKTOP);
  const enqueued: unknown[] = [];
  const response = await handleRuntimeCommand(request({ conversationId: "conversation_direct", text: "ship it", idempotencyKey: "anon-send-1" }), "send", dependencies(enqueued));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "sign in required", code: "member_required" });
  expect(enqueued).toEqual([]);
});

test("two members' sends each carry their sender, and the audit says who sent what", async () => {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP);
  const oleh = redeemJoin(store, createInvite(store, mira.member, null).code, "Oleh", DESKTOP);
  const enqueued: unknown[] = [];
  await handleRuntimeCommand(request({ conversationId: "conversation_direct", text: "review the seam", idempotencyKey: "mira-send-1" }, { cookie: `${MEMBER_COOKIE}=${mira.cookie}` }), "send", dependencies(enqueued));
  await handleRuntimeCommand(request({ conversationId: "conversation_direct", text: "check the host pin", idempotencyKey: "oleh-send-1" }, { cookie: `${MEMBER_COOKIE}=${oleh.cookie}` }), "send", dependencies(enqueued));
  expect(enqueued).toHaveLength(2);
  const senders = messageSenders(["mira-send-1", "oleh-send-1"]);
  expect(senders["mira-send-1"]?.name).toBe("Mira");
  expect(senders["oleh-send-1"]?.name).toBe("Oleh");
  const sent = existingTeamStore()!.events({ limit: 10, actions: ["message.sent"] });
  expect(sent.map((event) => event.actor)).toEqual([
    { kind: "member", memberId: oleh.member.id },
    { kind: "member", memberId: mira.member.id },
  ]);
  expect(sent.every((event) => event.subject?.id === "conversation_direct")).toBe(true);
  /* The audit never holds what was said. */
  const bytes = fs.readFileSync(teamStoreFile());
  expect(bytes.includes(Buffer.from("review the seam"))).toBe(false);
});

test("an agent's relay in a team is neither refused nor stamped with a person", async () => {
  claimInstall(teamStore(), "Mira", DESKTOP);
  const enqueued: unknown[] = [];
  await handleRuntimeCommand(request(
    { conversationId: "conversation_direct", text: "relay", idempotencyKey: "agent-send-1" },
    { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) },
  ), "send", dependencies(enqueued));
  expect(enqueued).toHaveLength(1);
  expect(messageSenders(["agent-send-1"])).toEqual({});
});

test("a send the host refuses leaves no author and no event", async () => {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP);
  const oleh = redeemJoin(store, createInvite(store, mira.member, null).code, "Oleh", DESKTOP);
  const response = await handleRuntimeCommand(
    request({ conversationId: "conversation_direct", text: "mine now", idempotencyKey: "delivered-earlier-by-someone-else" }, { cookie: `${MEMBER_COOKIE}=${oleh.cookie}` }),
    "send",
    dependencies([], "refuse"),
  );
  expect(response.status).toBe(409);
  expect(messageSenders(["delivered-earlier-by-someone-else"])).toEqual({});
  expect(sentEvents()).toEqual([]);
});

test("naming another message's submission id cannot make a member its sender", async () => {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP);
  const oleh = redeemJoin(store, createInvite(store, mira.member, null).code, "Oleh", DESKTOP);
  /* A task send the delivery record holds, with no author: the host would
     answer the reuse as a replay of that delivery. */
  const replayed = await handleRuntimeCommand(
    request({ conversationId: "conversation_direct", text: "task text", idempotencyKey: "task-send-1" }, { cookie: `${MEMBER_COOKIE}=${oleh.cookie}` }),
    "send",
    dependencies([], "admit", ["task-send-1"]),
  );
  expect(replayed.status).toBe(202);
  expect(messageSenders(["task-send-1"])).toEqual({});
  expect(sentEvents()).toEqual([]);

  /* Mira's own message: its sender does not change when Oleh names it. */
  await handleRuntimeCommand(
    request({ conversationId: "conversation_direct", text: "review the seam", idempotencyKey: "mira-send-2" }, { cookie: `${MEMBER_COOKIE}=${mira.cookie}` }),
    "send",
    dependencies([]),
  );
  await handleRuntimeCommand(
    request({ conversationId: "conversation_direct", text: "review the seam", idempotencyKey: "mira-send-2" }, { cookie: `${MEMBER_COOKIE}=${oleh.cookie}` }),
    "send",
    dependencies([], "admit"),
  );
  expect(messageSenders(["mira-send-2"])["mira-send-2"]?.memberId).toBe(mira.member.id);
  expect(sentEvents().map((event) => event.actor)).toEqual([{ kind: "member", memberId: mira.member.id }]);
});

test("an author is read back only on the conversation the message was sent into", async () => {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP);
  const oleh = redeemJoin(store, createInvite(store, mira.member, null).code, "Oleh", DESKTOP);
  /* Oleh sends into his own conversation under an id another conversation's
     message carries; that conversation's feed must not show him. */
  await handleRuntimeCommand(
    request({ conversationId: "conversation_oleh", text: "hello", idempotencyKey: "shared-id" }, { cookie: `${MEMBER_COOKIE}=${oleh.cookie}` }),
    "send",
    dependencies([]),
  );
  expect(messageSenders(["shared-id"], (id) => id === "conversation_oleh")["shared-id"]?.name).toBe("Oleh");
  expect(messageSenders(["shared-id"], (id) => id === "conversation_direct")).toEqual({});
});
