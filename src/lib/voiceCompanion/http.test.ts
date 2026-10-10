import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-http-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { companionStarter, companionOperator, companionSessionOwner, companionFailure } = await import("./http");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
const { MEMBER_COOKIE } = await import("@/lib/team/sessions");
const { CompanionAdmission } = await import("./admission");
const { CompanionStorage } = await import("./storage");
afterAll(() => { resetTeamStoreForTests(); fs.rmSync(root, { recursive: true, force: true }); });
const request = (cookie?: string, headers: Record<string, string> = {}) => new NextRequest("http://127.0.0.1/api/voice-companion/session", {
  headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", ...(cookie ? { cookie: `${MEMBER_COOKIE}=${cookie}` } : {}), ...headers },
});

test("human admission records only the member identity and refuses anonymous, service and agent claims", async () => {
  expect(companionStarter(request())).toEqual({ operator: true });
  const admission = new CompanionAdmission(new CompanionStorage(), { reports: () => [], recipient: () => null, send: async () => { throw new Error("unused"); } });
  const solo = admission.create({ project: "solo", locale: "en", startedBy: { operator: true } });
  const store = teamStore();
  const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" });
  const member = redeemJoin(store, createInvite(store, owner.member, null).code, "Member", { surface: "desktop", browser: "chrome" });
  expect(companionStarter(request(owner.cookie))).toEqual({ memberId: owner.member.id });
  expect(() => companionStarter(request())).toThrow("MEMBER_REQUIRED");
  expect(() => companionSessionOwner(request(owner.cookie), solo)).toThrow("MEMBER_REQUIRED");
  const owned = admission.create({ project: "member", locale: "en", startedBy: { memberId: member.member.id } });
  expect(() => companionSessionOwner(request(owner.cookie), owned)).toThrow("MEMBER_REQUIRED");
  expect(() => companionSessionOwner(request(member.cookie), owned)).not.toThrow();
  for (const value of ["invalid-agent", "invalid-service"]) {
    const denied = companionOperator(request(owner.cookie, { "x-llv-spawn-capability": value }));
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
  }
  store.updateMember({ ...member.member, status: "revoked", revokedAt: new Date().toISOString() });
  expect(() => companionStarter(request(member.cookie))).toThrow("MEMBER_REQUIRED");
});

test("privacy failures identify the required authority and suppress arbitrary exception text", async () => {
  expect(companionFailure(new Error("OPERATOR_REQUIRED")).status).toBe(403);
  expect(companionFailure(new Error("MEMBER_REQUIRED")).status).toBe(401);
  expect(await companionFailure(new Error("private provider detail")).json()).toEqual({ code: "COMPANION_UNAVAILABLE" });
});
