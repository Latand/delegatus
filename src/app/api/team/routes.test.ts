import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, type NextResponse } from "next/server";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests } from "@/lib/team/store";

import { POST as claim } from "./claim/route";
import { GET as events } from "./events/route";
import { POST as createInvite } from "./invites/route";
import { GET as previewJoin, POST as join } from "./join/[code]/route";
import { PATCH as patchMember } from "./members/[id]/route";
import { GET as team } from "./route";
import { POST as approve } from "./session/approve/route";
import { POST as startApproval } from "./session/approval/route";
import { POST as pollApproval } from "./session/approval/[id]/route";
import { POST as signOut } from "./session/sign-out/route";
import { GET as sessions } from "./sessions/route";

/*
 * The team routes end to end, the way two browsers use them (#1497's
 * acceptance): the operator claims the install, invites a teammate, the
 * teammate joins, signs a second device in by approval, is revoked, and the
 * audit names each step. Each "browser" is a cookie jar of one member cookie.
 */

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-team-routes-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
  setCallerConversationResolverForTests(() => "conversation_agent");
});

afterEach(() => {
  resetTeamStoreForTests();
  setCallerConversationResolverForTests(null);
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function call(url: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898${url}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      host: "127.0.0.1:8898",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: `${MEMBER_COOKIE}=${init.cookie}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieOf(response: NextResponse): string {
  const value = response.cookies.get(MEMBER_COOKIE)?.value;
  if (!value) throw new Error("the response set no member cookie");
  return value;
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

describe("claiming", () => {
  test("an agent cannot claim the install", async () => {
    const response = await claim(call("/api/team/claim", { body: { name: "Agent" }, headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) } }));
    expect(response.status).toBe(403);
    expect(fs.existsSync(path.join(stateDir, "team", "team.sqlite"))).toBe(false);
  });

  test("a solo install's team answer is solo and names nobody", async () => {
    const answer = await (await team(call("/api/team"))).json();
    expect(answer).toMatchObject({ mode: "solo", me: null, members: [] });
  });

  test("once claimed, a second claim is refused", async () => {
    expect((await claim(call("/api/team/claim", { body: { name: "Mira" } }))).status).toBe(200);
    expect((await claim(call("/api/team/claim", { body: { name: "Oleh" } }))).status).toBe(409);
  });
});

describe("two people on two devices", () => {
  test("claim, invite, join, approve a second device, revoke — and the audit says who did each", async () => {
    const miraCookie = cookieOf(await claim(call("/api/team/claim", { body: { name: "Mira" } })));

    /* The owner invites Oleh; the link carries the code once. */
    const invite = await (await createInvite(call("/api/team/invites", { body: { name: "Oleh" }, cookie: miraCookie }))).json() as { url: string };
    const code = new URL(invite.url).pathname.split("/").pop()!;
    expect(await (await previewJoin(call(`/api/team/join/${code}`), params({ code }))).json()).toEqual({ valid: true, kind: "invite", inviterName: "Mira", invitedName: "Oleh" });
    const joined = await join(call(`/api/team/join/${code}`, { body: { name: "Oleh" }, headers: { "user-agent": PHONE_UA } }), params({ code }));
    const olehPhone = cookieOf(joined);
    expect((await join(call(`/api/team/join/${code}`, { body: { name: "Again" } }), params({ code }))).status).toBe(410);

    /* A second browser of Oleh's asks; Oleh's phone approves it. */
    const asked = await (await startApproval(call("/api/team/session/approval", { body: {} }))).json() as { id: string; proof: string; code: string };
    expect(asked.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    const found = await (await approve(call("/api/team/session/approve", { body: { code: asked.code }, cookie: olehPhone }))).json() as { id: string; surface: string };
    expect(found.surface).toBe("other");
    expect((await approve(call("/api/team/session/approve", { body: { id: found.id, approve: true }, cookie: olehPhone }))).status).toBe(200);
    expect(await (await pollApproval(call(`/api/team/session/approval/${asked.id}`, { body: { proof: asked.proof } }), params({ id: asked.id }))).json()).toEqual({ state: "approved", name: "Oleh" });
    const olehDesktop = cookieOf(await pollApproval(call(`/api/team/session/approval/${asked.id}`, { body: { proof: asked.proof, complete: true } }), params({ id: asked.id })));

    /* Both of Oleh's browsers are Oleh, and a reload is just another request. */
    for (const cookie of [olehPhone, olehDesktop, olehDesktop]) {
      const view = await (await team(call("/api/team", { cookie }))).json() as { me: { name: string } };
      expect(view.me.name).toBe("Oleh");
    }
    const olehSessions = await (await sessions(call("/api/team/sessions", { cookie: olehDesktop }))).json() as { sessions: Array<{ method: string; current: boolean }> };
    expect(olehSessions.sessions.map((session) => session.method).sort()).toEqual(["approval", "invite"]);

    /* The owner revokes Oleh: both browsers are out at once. */
    const view = await (await team(call("/api/team", { cookie: miraCookie }))).json() as { members: Array<{ id: string; name: string }> };
    const olehId = view.members.find((member) => member.name === "Oleh")!.id;
    expect((await patchMember(call(`/api/team/members/${olehId}`, { method: "PATCH", body: { status: "revoked" }, cookie: olehPhone }), params({ id: olehId }))).status).toBe(403);
    expect((await patchMember(call(`/api/team/members/${olehId}`, { method: "PATCH", body: { status: "revoked" }, cookie: miraCookie }), params({ id: olehId }))).status).toBe(200);
    expect((await team(call("/api/team", { cookie: olehPhone }))).status).toBe(401);
    expect((await team(call("/api/team", { cookie: olehDesktop }))).status).toBe(401);

    /* The tab opens on the work people did; none of this is work yet. */
    const work = await (await events(call("/api/team/events", { cookie: miraCookie }))).json() as { events: unknown[] };
    expect(work.events).toEqual([]);
    const audit = await (await events(call("/api/team/events?scope=all", { cookie: miraCookie }))).json() as { events: Array<{ action: string; actor: { memberId?: string } }> };
    const actions = audit.events.map((event) => event.action).reverse();
    expect(actions).toEqual([
      "member.claimed", "session.signed_in",
      "member.invited",
      "member.joined", "session.signed_in",
      "device.approved", "session.signed_in",
      "member.revoked",
    ]);
  });

  test("signing out ends the session and clears the cookie", async () => {
    const cookie = cookieOf(await claim(call("/api/team/claim", { body: { name: "Mira" } })));
    const response = await signOut(call("/api/team/session/sign-out", { body: {}, cookie }));
    expect(response.cookies.get(MEMBER_COOKIE)?.value).toBe("");
    expect((await team(call("/api/team", { cookie }))).status).toBe(401);
  });
});
