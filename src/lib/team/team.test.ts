import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { installSpawnCapabilityResolver, internalServiceHeaders, spawnCapabilityDigest } from "@/lib/agent/callerClaims";

import { teamGate } from "./gate";
import {
  claimInstall,
  completeApproval,
  confirmApproval,
  createHandoff,
  createInvite,
  createRecovery,
  lookupApproval,
  previewJoin,
  redeemJoin,
  renameMember,
  revokeMember,
  startApproval,
  challengeForRequester,
  approvalState,
  TeamError,
  withdrawInvite,
  teamView,
} from "./members";
import { appendTeamEvent, messageTextDigest, recordTeamEvent } from "./events";
import { messageSenders, recordAuthors, subjectAuthorship } from "./index";
import { MEMBER_COOKIE, requestSession, sessionIsLive, teamMode, verifySessionValue } from "./sessions";
import { existingTeamStore, resetTeamStoreForTests, SESSION_IDLE_MS, teamStore, teamStoreFile } from "./store";

/*
 * The team module against a real SQLite file in a throw-away state directory:
 * the owner's claim, invites, approving a device, the phone hand-off, host
 * recovery, revocation, and the identity gate's whole matrix.
 */

const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const PHONE = { surface: "phone" as const, browser: "safari" as const };
const METHODS = { approval: true, telegram: { available: false, botUsername: null }, passkey: { available: false } };

let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-team-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
});

afterEach(() => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function request(url: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}): NextRequest {
  const headers: Record<string, string> = { host: "127.0.0.1:8898", ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = `${MEMBER_COOKIE}=${init.cookie}`;
  return new NextRequest(`http://127.0.0.1:8898${url}`, { method: init.method ?? "GET", headers });
}

describe("solo mode is the absence of a team", () => {
  test("a fresh state directory is solo, and asking creates nothing", () => {
    expect(teamMode()).toBe("solo");
    expect(existingTeamStore()).toBeNull();
    expect(teamGate(request("/"), { bearerAuthenticated: false })).toBeNull();
    expect(teamGate(request("/api/files", { method: "POST" }), { bearerAuthenticated: false })).toBeNull();
    recordTeamEvent({ actor: { kind: "service", service: "telegram" }, action: "join.requested" });
    expect(fs.existsSync(teamStoreFile())).toBe(false);
  });
});

describe("claiming the install", () => {
  test("the claim makes an owner, signs this browser in, and flips the install to team mode", () => {
    const claimed = claimInstall(teamStore(), "Mira Koval", DESKTOP);
    expect(claimed.member.role).toBe("owner");
    expect(teamMode()).toBe("team");
    const live = verifySessionValue(teamStore(), claimed.cookie);
    expect(live?.member.name).toBe("Mira Koval");
    expect(live?.session.method).toBe("claim");
    /* Only the hash is stored. */
    const bytes = fs.readFileSync(teamStoreFile());
    expect(bytes.includes(Buffer.from(claimed.cookie))).toBe(false);
  });

  test("a second claim is refused", () => {
    claimInstall(teamStore(), "Mira", DESKTOP);
    expect(() => claimInstall(teamStore(), "Oleh", DESKTOP)).toThrow(TeamError);
  });

  test("a claim needs a name", () => {
    expect(() => claimInstall(teamStore(), "   ", DESKTOP)).toThrow("a name is required");
    expect(teamMode()).toBe("solo");
  });
});

describe("invites", () => {
  test("an invite joins a member once, and the second use is refused", () => {
    const store = teamStore();
    const owner = claimInstall(store, "Mira", DESKTOP).member;
    const { code } = createInvite(store, owner, "Oleh");
    expect(previewJoin(store, code)).toEqual({ valid: true, kind: "invite", inviterName: "Mira", invitedName: "Oleh" });
    const joined = redeemJoin(store, code, "Oleh Hnatiuk", PHONE);
    expect(joined.member.role).toBe("member");
    expect(joined.member.color).not.toBe(owner.color);
    expect(verifySessionValue(store, joined.cookie)?.member.id).toBe(joined.member.id);
    expect(previewJoin(store, code)).toEqual({ valid: false });
    expect(() => redeemJoin(store, code, "Someone", PHONE)).toThrow("this link was already used or has expired");
  });

  test("a withdrawn invite and an expired invite both stop working", () => {
    const store = teamStore();
    const owner = claimInstall(store, "Mira", DESKTOP).member;
    const withdrawn = createInvite(store, owner, null);
    expect(withdrawInvite(store, withdrawn.challenge.id)).toBe(true);
    expect(() => redeemJoin(store, withdrawn.code, "Oleh", PHONE)).toThrow(TeamError);
    const now = Date.now();
    const expiring = createInvite(store, owner, null, now);
    expect(() => redeemJoin(store, expiring.code, "Oleh", PHONE, now + 8 * 24 * 3_600_000)).toThrow(TeamError);
  });

  test("an unknown or malformed code says only that it is invalid", () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    expect(previewJoin(store, "not-a-code")).toEqual({ valid: false });
    expect(previewJoin(store, "A".repeat(22))).toEqual({ valid: false });
  });
});

describe("approving a device", () => {
  test("the new device becomes the approver, and only the holder of the proof completes it", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const { challenge, proof } = startApproval(store, PHONE);
    expect(challenge.userCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(challengeForRequester(store, challenge.id, "wrong-proof-00000000", "approval")).toBeNull();
    const held = challengeForRequester(store, challenge.id, proof, "approval")!;
    expect(approvalState(store, held).state).toBe("waiting");

    const found = lookupApproval(store, mira, challenge.userCode!.toLowerCase());
    expect(found.requester).toEqual(PHONE);
    confirmApproval(store, mira, found.id, true);
    expect(approvalState(store, store.challenge(challenge.id)!)).toEqual({ state: "approved", name: "Mira" });
    const signedIn = completeApproval(store, held, PHONE);
    expect(signedIn.member.id).toBe(mira.id);
    expect(signedIn.session.method).toBe("approval");
    expect(() => completeApproval(store, held, PHONE)).toThrow(TeamError);
  });

  test("five wrong codes stop the approver from guessing for ten minutes", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const { challenge } = startApproval(store, PHONE);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => lookupApproval(store, mira, "ZZZ-ZZZ")).toThrow("that code is not right");
    }
    expect(() => lookupApproval(store, mira, challenge.userCode)).toThrow("too many wrong codes");
  });
});

describe("the phone hand-off and host recovery", () => {
  test("a hand-off signs the phone in as the member who made it, once", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const { code } = createHandoff(store, mira);
    expect(previewJoin(store, code)).toEqual({ valid: true, kind: "handoff", memberName: "Mira" });
    const phone = redeemJoin(store, code, undefined, PHONE);
    expect(phone.member.id).toBe(mira.id);
    expect(phone.session.method).toBe("handoff");
    expect(() => redeemJoin(store, code, undefined, PHONE)).toThrow(TeamError);
  });

  test("recovery signs in as the owner", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const { code } = createRecovery(store);
    const recovered = redeemJoin(store, code, undefined, DESKTOP);
    expect(recovered.member.id).toBe(mira.id);
    expect(recovered.session.method).toBe("recovery");
  });
});

describe("sessions and revocation", () => {
  test("revoking a member ends every session at once and keeps their name on what they sent", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const oleh = redeemJoin(store, createInvite(store, mira, null).code, "Oleh", PHONE);
    store.recordMessageAuthor({ clientMessageId: "msg-oleh-1", conversationId: "conversation_x", memberId: oleh.member.id, at: new Date().toISOString(), textDigest: null });
    revokeMember(store, mira, oleh.member);
    expect(verifySessionValue(store, oleh.cookie)).toBeNull();
    expect(teamGate(request("/api/tasks", { method: "POST", cookie: oleh.cookie }), { bearerAuthenticated: false })?.status).toBe(401);
    expect(messageSenders(["msg-oleh-1"])["msg-oleh-1"]?.name).toBe("Oleh");
  });

  test("the owner cannot be revoked", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    expect(() => revokeMember(store, mira, mira)).toThrow("the owner cannot be revoked");
  });

  test("a session idle for thirty days is dead", () => {
    const store = teamStore();
    const now = Date.now();
    const { cookie, session } = claimInstall(store, "Mira", DESKTOP, now);
    expect(sessionIsLive(session, now + SESSION_IDLE_MS - 1)).toBe(true);
    expect(verifySessionValue(store, cookie, now + SESSION_IDLE_MS + 1)).toBeNull();
  });

  test("a rename reads everywhere, because names are joined at read time", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    store.recordMessageAuthor({ clientMessageId: "msg-1", conversationId: null, memberId: mira.id, at: new Date().toISOString(), textDigest: null });
    renameMember(store, mira, mira, "Mira K.");
    expect(messageSenders(["msg-1", "unknown"])).toEqual({ "msg-1": { memberId: mira.id, name: "Mira K.", color: mira.color, initials: "MK" } });
  });

  test("a sender is named only on the conversation the member sent into", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    store.recordMessageAuthor({ clientMessageId: "msg-a", conversationId: "conversation_a", memberId: mira.id, at: new Date().toISOString(), textDigest: null });
    store.recordMessageAuthor({ clientMessageId: "msg-none", conversationId: null, memberId: mira.id, at: new Date().toISOString(), textDigest: null });
    const inA = (id: string) => id === "conversation_a";
    const inB = (id: string) => id === "conversation_b";
    expect(Object.keys(messageSenders(["msg-a", "msg-none"], inA))).toEqual(["msg-a"]);
    expect(messageSenders(["msg-a", "msg-none"], inB)).toEqual({});
  });

  test("a request's cookie resolves to its member", () => {
    const store = teamStore();
    const { cookie, member } = claimInstall(store, "Mira", DESKTOP);
    expect(requestSession(request("/", { cookie }))?.member.id).toBe(member.id);
    expect(requestSession(request("/", { cookie: "x".repeat(43) }))).toBeNull();
  });
});

describe("the identity gate in team mode", () => {
  /* A capability the registry issued, as the stubbed lookup knows it. */
  const REAL_CAPABILITY = "R".repeat(43);
  let cookie = "";
  beforeEach(() => {
    cookie = claimInstall(teamStore(), "Mira", DESKTOP).cookie;
    installSpawnCapabilityResolver((digest) => (digest === spawnCapabilityDigest(REAL_CAPABILITY) ? "conversation_agent" : null));
  });
  afterEach(() => installSpawnCapabilityResolver(null));

  const monitorTag = () => internalServiceHeaders("monitor");
  const probeTag = () => internalServiceHeaders("probe");
  const cases: Array<[string, { path: string; method?: string; cookie?: boolean; headers?: Record<string, string> | (() => Record<string, string>); bearer?: boolean }, number | null]> = [
    ["the sign-in page", { path: "/sign-in" }, null],
    ["a join link", { path: "/join/abc" }, null],
    ["the public team answer", { path: "/api/team/public" }, null],
    ["a sign-in endpoint", { path: "/api/team/session/approval", method: "POST" }, null],
    ["a static asset", { path: "/_next/static/chunk.js" }, null],
    ["an agent's capability the registry issued", { path: "/api/tasks", method: "POST", headers: { "x-llv-spawn-capability": REAL_CAPABILITY } }, null],
    ["a forged capability on a write", { path: "/api/tasks", method: "POST", headers: { "x-llv-spawn-capability": "A".repeat(43) } }, 401],
    ["a forged capability on a navigation", { path: "/", headers: { "x-llv-spawn-capability": "A".repeat(43), "sec-fetch-mode": "navigate" } }, 307],
    ["a Viewer service tag", { path: "/api/tasks", method: "POST", headers: monitorTag }, null],
    ["a forged service tag on a write", { path: "/api/tasks", method: "POST", headers: { "x-llv-internal-service": `monitor.${"a".repeat(64)}` } }, 401],
    ["a forged service tag on a navigation", { path: "/", headers: { "x-llv-internal-service": `zz.${"0".repeat(64)}`, "sec-fetch-mode": "navigate" } }, 307],
    ["a probe's tag on a read", { path: "/", headers: probeTag }, null],
    ["a probe's tag on a write", { path: "/api/tasks", method: "POST", headers: probeTag }, 401],
    ["a bearer read", { path: "/", bearer: true }, null],
    ["a bearer write", { path: "/api/tasks", method: "POST", bearer: true }, 401],
    ["a live cookie", { path: "/api/tasks", method: "POST", cookie: true }, null],
    ["a navigation without a session", { path: "/team?tab=activity", headers: { "sec-fetch-mode": "navigate" } }, 307],
    ["a fetch without a session", { path: "/api/files" }, 401],
    ["the event stream without a session", { path: "/api/logs/stream" }, 401],
  ];
  for (const [name, input, status] of cases) {
    test(name, () => {
      const headers = typeof input.headers === "function" ? input.headers() : input.headers;
      const answer = teamGate(request(input.path, { method: input.method, cookie: input.cookie ? cookie : undefined, headers }), { bearerAuthenticated: Boolean(input.bearer) });
      expect(answer?.status ?? null).toBe(status);
    });
  }

  test("a navigation returns to where it was asked for, as a path", () => {
    const answer = teamGate(request("/team?tab=activity", { headers: { "sec-fetch-mode": "navigate" } }), { bearerAuthenticated: false });
    const location = new URL(answer!.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/team?tab=activity");
  });

  test("a refused API call names the reason", async () => {
    const answer = teamGate(request("/api/files"), { bearerAuthenticated: false });
    expect(await answer!.json()).toEqual({ error: "sign in required", code: "member_required" });
  });
});

describe("who did what", () => {
  test("a person's events are recorded and an agent's are not", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    recordTeamEvent({ actor: { kind: "member", memberId: mira.id }, action: "task.created", project: "lantern", subject: { kind: "task", id: "t-1", title: "Board undo" } });
    recordTeamEvent({ actor: { kind: "agent", conversationId: "conversation_a" }, action: "task.created", subject: { kind: "task", id: "t-2", title: "x" } });
    recordTeamEvent({ actor: { kind: "operator" }, action: "task.created", subject: { kind: "task", id: "t-3", title: "x" } });
    const tasks = store.events({ limit: 50, actions: ["task.created"] });
    expect(tasks.map((event) => event.subject?.id)).toEqual(["t-1"]);
    expect(store.eventProjects()).toEqual(["lantern"]);
  });

  test("the audit answers who started a conversation and who last changed a task", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const oleh = redeemJoin(store, createInvite(store, mira, null).code, "Oleh", PHONE).member;
    const now = Date.now();
    appendTeamEvent(store, { actor: { kind: "member", memberId: oleh.id }, action: "agent.started", subject: { kind: "conversation", id: "conversation_r", title: "Review" } }, now);
    appendTeamEvent(store, { actor: { kind: "member", memberId: mira.id }, action: "task.created", subject: { kind: "task", id: "t-9", title: "Undo" } }, now + 1);
    appendTeamEvent(store, { actor: { kind: "member", memberId: oleh.id }, action: "task.changed", subject: { kind: "task", id: "t-9", title: "Undo" }, detail: { fields: "status", from: "inbox", to: "assigned" } }, now + 2);
    const authorship = subjectAuthorship(["conversation_r", "t-9", "t-none"]);
    expect(authorship.conversation_r?.startedBy?.name).toBe("Oleh");
    expect(authorship["t-9"]?.startedBy?.name).toBe("Mira");
    expect(authorship["t-9"]?.changedBy?.name).toBe("Oleh");
    expect(authorship["t-none"]).toBeUndefined();
  });

  test("the team view names members, their passkeys and where they were last seen", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const view = teamView(store, mira, METHODS);
    expect(view.mode).toBe("team");
    expect(view.me?.name).toBe("Mira");
    expect(view.members).toHaveLength(1);
    expect(view.members[0]).toMatchObject({ name: "Mira", passkeys: 0, lastSurface: "desktop" });
    /* A member who signed out still reads as seen. */
    store.revokeSessionsOf(mira.id, new Date().toISOString());
    expect(teamView(store, mira, METHODS).members[0]?.lastSeenAt).not.toBeNull();
  });

  test("an MCP read names the member behind each user record, and names nothing it cannot prove", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const oleh = redeemJoin(store, createInvite(store, mira, null).code, "Oleh", PHONE).member;
    const t0 = Date.parse("2026-09-26T10:00:00.000Z");
    const row = (id: string, member: string, text: string, ms: number) => store.recordMessageAuthor({ clientMessageId: id, conversationId: "conversation_c", memberId: member, at: new Date(ms).toISOString(), textDigest: messageTextDigest(text) });
    row("s1", mira.id, "review the seam", t0);
    row("s2", oleh.id, "review the seam", t0 + 60_000);
    row("s3", oleh.id, "check the pin", t0 + 120_000);
    const authors = recordAuthors("conversation_c", [
      { role: "user", ts: new Date(t0 + 1_000).toISOString(), text: "review the seam" },
      { role: "assistant", ts: new Date(t0 + 2_000).toISOString(), text: "on it" },
      { role: "user", ts: new Date(t0 + 61_000).toISOString(), text: "<!-- llv:structured-user ctx=d.x -->\nreview the seam" },
      { role: "user", ts: new Date(t0 + 121_000).toISOString(), text: "check the pin" },
      { role: "user", ts: new Date(t0 + 200_000).toISOString(), text: "typed by nobody we know" },
    ]);
    expect([...authors].map(([index, author]) => [index, author.name])).toEqual([[0, "Mira"], [2, "Oleh"], [3, "Oleh"]]);
    expect(recordAuthors("conversation_other", [{ role: "user", ts: new Date(t0).toISOString(), text: "review the seam" }]).size).toBe(0);
  });

  test("two members sending the same words seconds apart each keep their own record", () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const oleh = redeemJoin(store, createInvite(store, mira, null).code, "Oleh", PHONE).member;
    const t0 = Date.parse("2026-09-26T11:00:00.000Z");
    const row = (id: string, member: string, ms: number) => store.recordMessageAuthor({ clientMessageId: id, conversationId: "conversation_d", memberId: member, at: new Date(ms).toISOString(), textDigest: messageTextDigest("ship it") });
    row("a", mira.id, t0);
    row("b", oleh.id, t0 + 3_000);
    const authors = recordAuthors("conversation_d", [
      { role: "user", ts: new Date(t0 + 500).toISOString(), text: "ship it" },
      { role: "user", ts: new Date(t0 + 3_500).toISOString(), text: "ship it" },
    ]);
    expect([...authors].map(([index, author]) => [index, author.name])).toEqual([[0, "Mira"], [1, "Oleh"]]);
    /* A record stamped a moment before its send (another clock) still finds it. */
    const early = recordAuthors("conversation_d", [{ role: "user", ts: new Date(t0 - 1_000).toISOString(), text: "ship it" }]);
    expect(early.get(0)?.name).toBe("Mira");
  });
});
