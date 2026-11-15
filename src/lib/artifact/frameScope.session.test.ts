import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintFrameScope, verifyFrameScope } from "./frameScope";
import { claimInstall, createInvite, redeemJoin, restoreMember, revokeMember } from "@/lib/team/members";
import { mintSession } from "@/lib/team/sessions";
import { resetTeamStoreForTests, SESSION_IDLE_MS, teamStore } from "@/lib/team/store";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const device = { surface: "desktop" as const, browser: "chrome" as const };
const original = process.env.LLV_STATE_DIR;
let directory: string;
afterEach(() => {
  resetTeamStoreForTests();
  if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("a frame minted before member revocation is refused, including after restoration", () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "frame-session-"));
  process.env.LLV_STATE_DIR = directory;
  resetTeamStoreForTests();
  const store = teamStore();
  const owner = claimInstall(store, "Owner", device, NOW).member;
  const person = redeemJoin(store, createInvite(store, owner, null, NOW).code, "Member A", device, NOW);
  // The third argument binds the capability to a session; older versions ignore it.
  const mint = mintFrameScope as (directory: string, now: number, sessionId: string) => string;
  const scope = mint("/project/reports", NOW, person.session.id);
  expect(verifyFrameScope(scope, NOW)).toBe("/project/reports");
  revokeMember(store, owner, person.member, NOW + 1);
  expect(verifyFrameScope(scope, NOW + 2)).toBeNull();
  restoreMember(store, owner, store.member(person.member.id)!, NOW + 3);
  expect(verifyFrameScope(scope, NOW + 4)).toBeNull();
});

test("sign-out revokes only that session's frames", () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "frame-session-"));
  process.env.LLV_STATE_DIR = directory;
  resetTeamStoreForTests();
  const store = teamStore();
  const owner = claimInstall(store, "Owner", device, NOW);
  const second = mintSession(store, owner.member.id, "approval", device, NOW);
  const mint = mintFrameScope as (directory: string, now: number, sessionId: string) => string;
  const firstFrame = mint("/project/reports", NOW, owner.session.id);
  const secondFrame = mint("/project/reports", NOW, second.session.id);
  store.revokeSession(owner.session.id, new Date(NOW + 1).toISOString());
  expect(verifyFrameScope(firstFrame, NOW + 2)).toBeNull();
  expect(verifyFrameScope(secondFrame, NOW + 2)).toBe("/project/reports");
});

test("a session's absolute expiry and idle bound are checked even within a new frame's lifetime", () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "frame-session-"));
  process.env.LLV_STATE_DIR = directory;
  resetTeamStoreForTests();
  const store = teamStore();
  const owner = claimInstall(store, "Owner", device, NOW);
  const session = { ...owner.session, id: "expired-session", expiresAt: new Date(NOW + 1).toISOString() };
  store.insertSession(session);
  const expiring = mintFrameScope("/project/reports", NOW, session.id);
  expect(verifyFrameScope(expiring, NOW)).toBe("/project/reports");
  expect(verifyFrameScope(expiring, NOW + 1)).toBeNull();
  const stale = { ...owner.session, id: "idle-session", lastSeenAt: new Date(NOW - SESSION_IDLE_MS).toISOString() };
  store.insertSession(stale);
  expect(verifyFrameScope(mintFrameScope("/project/reports", NOW, stale.id), NOW)).toBeNull();
});

test("unbound, altered and unreadable session authority grant no team frame", () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "frame-session-"));
  process.env.LLV_STATE_DIR = directory;
  resetTeamStoreForTests();
  const store = teamStore();
  const owner = claimInstall(store, "Owner", device, NOW);
  expect(verifyFrameScope(mintFrameScope("/project/reports", NOW), NOW)).toBeNull();
  const scope = mintFrameScope("/project/reports", NOW, owner.session.id);
  expect(verifyFrameScope(scope.replace(owner.session.id, "another-session"), NOW)).toBeNull();
  const read = spyOn(store, "session").mockImplementation(() => { throw Error("injected session read failure"); });
  try { expect(verifyFrameScope(scope, NOW)).toBeNull(); }
  finally { read.mockRestore(); }
});
