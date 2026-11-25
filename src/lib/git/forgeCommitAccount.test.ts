import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fixtureForgeAccount, seedForgeCommitAccount } from "@/test-helpers/forgeCommitAccount";
import { forgeCommitAccountStatus, resolveForgeCommitAccount } from "./forgeCommitAccount";

const now = Date.parse("2026-11-26T16:10:00Z");
const user = { ...fixtureForgeAccount, type: "User" };
let sandbox: string;
let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = { ...process.env };
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "forge-commit-account-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.LLV_STATE_OWNER = "viewer";
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("reads the operator gh account once, strips token overrides and persists the validated result", async () => {
  const config = path.join(sandbox, "gh");
  process.env.GH_CONFIG_DIR = config;
  const overrideKeys = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
  for (const key of overrideKeys) process.env[key] = "fixture";
  let reads = 0;
  const run: NonNullable<Parameters<typeof resolveForgeCommitAccount>[0]>["run"] = async (args, options) => {
    expect(args).toEqual(["api", "user", "--hostname", "github.com", "--jq", "{id,login,type}"]);
    expect(options.env?.GH_CONFIG_DIR).toBe(config);
    for (const key of overrideKeys) expect(options.env?.[key]).toBeUndefined();
    reads++;
    return JSON.stringify(user);
  };
  const results = await Promise.all([resolveForgeCommitAccount({ now: () => now, run }), resolveForgeCommitAccount({ now: () => now, run })]);
  expect(reads).toBe(1);
  expect(results[0]).toEqual(results[1]);
  const file = path.join(sandbox, "forge-commit-account.json");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    schemaVersion: 1, host: "github.com", ...fixtureForgeAccount, resolvedAt: now, checkedAt: now,
  });
  delete process.env.LLV_STATE_OWNER;
  expect(await resolveForgeCommitAccount({ run })).toEqual(results[0]);
  expect(forgeCommitAccountStatus()).toEqual({ state: "resolved", login: user.login });
});

test.each([
  { ...user, type: "Bot" }, { ...user, id: 0 }, { ...user, id: 2 ** 53 }, { ...user, login: "invalid login" },
])("an invalid GitHub user response leaves the account unresolved (%j)", async answer => {
  const run = async () => JSON.stringify(answer);
  expect(await resolveForgeCommitAccount({ now: () => now, run })).toBeNull();
  expect(fs.existsSync(path.join(sandbox, "forge-commit-account.json"))).toBe(false);
  expect(forgeCommitAccountStatus()).toMatchObject({ state: "unresolved", reason: expect.stringContaining("gh auth login") });
});

test("no owner can read a cached account and cannot run gh for a missing account", async () => {
  delete process.env.LLV_STATE_OWNER;
  let invoked = false;
  const run = async () => { invoked = true; return JSON.stringify(user); };
  expect(await resolveForgeCommitAccount({ run })).toBeNull();
  seedForgeCommitAccount(sandbox);
  expect(await resolveForgeCommitAccount({ run })).toMatchObject(fixtureForgeAccount);
  expect(invoked).toBe(false);
});

test("an expired account stays usable while one background refresh replaces it", async () => {
  seedForgeCommitAccount(sandbox, now - 86_400_000);
  const next = { id: user.id + 1, login: "fixture-next" };
  let finish!: (result: string) => void;
  const lookup = new Promise<string>(resolve => { finish = resolve; });
  let calls = 0;
  const options = { now: () => now, run: () => { calls++; return lookup; } };
  expect(await resolveForgeCommitAccount(options)).toMatchObject(fixtureForgeAccount);
  expect(await resolveForgeCommitAccount(options)).toMatchObject(fixtureForgeAccount);
  expect(calls).toBe(1);
  finish(JSON.stringify({ ...next, type: "User" }));
  await lookup;
  expect(forgeCommitAccountStatus()).toEqual({ state: "resolved", login: next.login });
  expect(await resolveForgeCommitAccount(options)).toMatchObject({ ...next, checkedAt: now, resolvedAt: now });
  expect(calls).toBe(1);
});

test("failed refresh retains the last account and backs off", async () => {
  seedForgeCommitAccount(sandbox, now - 86_400_000);
  let calls = 0;
  const options = { now: () => now, run: async () => { calls++; throw new Error("fixture failure"); } };
  expect(await resolveForgeCommitAccount(options)).toMatchObject(fixtureForgeAccount);
  expect(await resolveForgeCommitAccount(options)).toMatchObject(fixtureForgeAccount);
  expect(calls).toBe(1);
});

test("an earlier lookup cannot replace an account written during its GitHub request", async () => {
  const result = await resolveForgeCommitAccount({ now: () => now, run: async () => {
    seedForgeCommitAccount(sandbox, now + 1);
    return JSON.stringify({ id: user.id + 1, login: "fixture-old", type: "User" });
  } });
  expect(result).toMatchObject({ ...fixtureForgeAccount, checkedAt: now + 1 });
});
