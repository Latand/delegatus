import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTeamCommand } from "../../../bin/team.mjs";

import { claimInstall, createInvite, redeemJoin } from "./members";
import { verifySessionValue } from "./sessions";
import { resetTeamStoreForTests, teamStore } from "./store";

/*
 * `delegatus team recover` and `revoke-sessions` (sign-in-and-team §5.5).
 * The command is plain `.mjs` and writes the store's tables itself, so this
 * test makes the store with the TypeScript module, runs the command against
 * it, and redeems the link it printed through the module's own join code.
 */

const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-team-cli-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
});

afterEach(() => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runTeamCommand(args, { stateDirectory: stateDir, port: 8898, env, log: (line: string) => lines.push(line) });
  return { code, out: lines.join("\n") };
}

describe("delegatus team", () => {
  test("recover prints a one-time link that signs its browser in as the owner", async () => {
    const mira = claimInstall(teamStore(), "Mira", DESKTOP).member;
    const { code, out } = await run(["recover", "--origin", "https://dev.example.net:8443"], { LLV_TOKEN: "k".repeat(43) });
    expect(code).toBe(0);
    expect(out).toContain("sign in as Mira");
    const url = new URL(out.match(/https:\/\/\S+/)![0]);
    expect(url.origin).toBe("https://dev.example.net:8443");
    expect(url.searchParams.get("k")).toBe("k".repeat(43));
    const joinCode = url.pathname.split("/").pop()!;
    const recovered = redeemJoin(teamStore(), joinCode, undefined, DESKTOP);
    expect(recovered.member.id).toBe(mira.id);
    expect(recovered.session.method).toBe("recovery");
    expect(() => redeemJoin(teamStore(), joinCode, undefined, DESKTOP)).toThrow();
  });

  test("revoke-sessions signs everyone out everywhere", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP);
    const oleh = redeemJoin(store, createInvite(store, mira.member, null).code, "Oleh", DESKTOP);
    const { code, out } = await run(["revoke-sessions"]);
    expect(code).toBe(0);
    expect(out).toContain("Signed out 2 session(s)");
    expect(verifySessionValue(store, mira.cookie)).toBeNull();
    expect(verifySessionValue(store, oleh.cookie)).toBeNull();
  });

  test("an install without a team has nothing to recover and gets no file", async () => {
    const { code, out } = await run(["recover"]);
    expect(code).toBe(1);
    expect(out).toContain("no team");
    expect(fs.existsSync(path.join(stateDir, "team", "team.sqlite"))).toBe(false);
  });

  test("an unknown command prints the usage", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run([])).out).toContain("delegatus team recover");
  });
});
