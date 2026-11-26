import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { authenticatedOwner, ownerTelegramGap } from "./actor";
import { OWNER_TELEGRAM_GAPS, isOwnerTelegramGap, nullTeam } from "./contract";
import { claimInstall } from "./members";
import { MEMBER_COOKIE, mintSession } from "./sessions";
import { resetTeamStoreForTests, teamStore } from "./store";

/* Why an owner-only Telegram action refuses a browser, against a real team
   store: the first missing step in the order a person can fix them, and the
   same yes-or-no answer `authenticatedOwner` always gave every caller. */

const DEVICE = { surface: "desktop" as const, browser: "chrome" as const };
const PAIRED = "700001";
const OTHER = "700002";
let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-owner-gap-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
});
afterEach(() => {
  resetTeamStoreForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const asked = (cookie?: string) => new NextRequest("http://127.0.0.1/api/telegram/bot/confirmation", { headers: cookie ? { cookie: `${MEMBER_COOKIE}=${cookie}` } : {} });
const telegram = (userId: string) => ({ userId, username: null, firstName: "Fixture", linkedAt: "2026-10-22T12:00:00.000Z" });

function install(linked: string | null) {
  const claimed = claimInstall(teamStore(), "Owner", DEVICE);
  if (linked) teamStore().updateMember({ ...claimed.member, telegram: telegram(linked) });
  return claimed;
}
const session = (memberId: string, method: "approval" | "telegram" | "claim") => mintSession(teamStore(), memberId, method, DEVICE).value;

test("an install with no team store or no owner names the team as the missing step", () => {
  expect(ownerTelegramGap(asked(), PAIRED)).toBe("team");
  expect(authenticatedOwner(asked(), PAIRED)).toBe(false);
  expect(nullTeam.ownerTelegramGap(asked(), PAIRED)).toBe("team");
});

test("a browser nobody is signed in on, or a dead session, names no step", () => {
  const { member } = install(PAIRED);
  expect(ownerTelegramGap(asked(), PAIRED)).toBe("unverified");
  expect(ownerTelegramGap(asked("x".repeat(43)), PAIRED)).toBe("unverified");
  const dead = mintSession(teamStore(), member.id, "telegram", DEVICE);
  teamStore().revokeSession(dead.session.id, "2026-10-22T12:00:00.000Z");
  expect(ownerTelegramGap(asked(dead.value), PAIRED)).toBe("unverified");
});

test("the first missing step comes in the order a person can fix them", () => {
  const { member } = install(null);
  const approval = session(member.id, "approval");
  teamStore().insertMember({ ...member, id: "m_stranger_fixture", name: "Member", role: "member", telegram: null, createdBy: member.id });
  const memberCookie = session("m_stranger_fixture", "telegram");

  // Another member is stopped before anything about the owner or the pairing.
  expect(ownerTelegramGap(asked(memberCookie), undefined)).toBe("owner");
  // Without a pairing nothing about the owner's Telegram can help yet.
  expect(ownerTelegramGap(asked(approval), undefined)).toBe("pairing");
  expect(ownerTelegramGap(asked(approval), PAIRED)).toBe("telegram_link");

  teamStore().updateMember({ ...member, telegram: telegram(OTHER) });
  expect(ownerTelegramGap(asked(approval), PAIRED)).toBe("telegram_account");
  expect(ownerTelegramGap(asked(session(member.id, "telegram")), PAIRED)).toBe("telegram_account");

  teamStore().updateMember({ ...member, telegram: telegram(PAIRED) });
  expect(ownerTelegramGap(asked(approval), PAIRED)).toBe("telegram_session");
  expect(ownerTelegramGap(asked(session(member.id, "claim")), PAIRED)).toBe("telegram_session");
  expect(ownerTelegramGap(asked(session(member.id, "telegram")), PAIRED)).toBeNull();
});

test("authenticatedOwner stays the yes-or-no of the gap for every kind of browser", () => {
  const { member } = install(PAIRED);
  const cookies: Array<[string | undefined, string | undefined]> = [
    [undefined, PAIRED], ["x".repeat(43), PAIRED],
    [session(member.id, "telegram"), PAIRED], [session(member.id, "telegram"), OTHER], [session(member.id, "telegram"), undefined],
    [session(member.id, "approval"), PAIRED], [session(member.id, "claim"), PAIRED], [session(member.id, "approval"), undefined],
  ];
  const answers = cookies.map(([cookie, paired]) => [ownerTelegramGap(asked(cookie), paired) === null, authenticatedOwner(asked(cookie), paired)]);
  expect(answers.map(([gap, owner]) => gap === owner)).toEqual(cookies.map(() => true));
  expect(answers.map(([, owner]) => owner)).toEqual([false, false, true, false, false, false, false, false]);
});

test("every reason the page can show is a known step", () => {
  expect(OWNER_TELEGRAM_GAPS.every(isOwnerTelegramGap)).toBe(true);
  expect(isOwnerTelegramGap("unverified")).toBe(false);
  expect(isOwnerTelegramGap(undefined)).toBe(false);
  expect(isOwnerTelegramGap({ constructor: "team" })).toBe(false);
});
