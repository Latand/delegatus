import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { prepareCloudEnvironment, readCloudEnvironmentBindings, setCloudEnvironmentOverride, cloudEnvironmentSelection } from "./codexCloudEnvironments";


import { cloudEnvironmentTestContext } from "./codexCloudEnvironments.fixture";

const { fixture, restart, cleanup } = cloudEnvironmentTestContext();
afterEach(cleanup);

test("an override written before project succession retains its revision through aliases and process restart", async () => {
  const f = fixture();
  await setCloudEnvironmentOverride({ project: f.input.project, accountId: "account-a", environmentId: "asenvcfg_account-a", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  await f.prepare();
  const { persistProjectAliases } = await import("./aliases");
  expect(persistProjectAliases([{ source: f.input.project, target: "repo-successor", displayName: "Fixture" }])).toBe(true);
  for (const project of [f.input.project, "repo-successor"]) {
    expect(cloudEnvironmentSelection(project, "account-a")).toEqual({ environmentId: "asenvcfg_account-a", source: "account-override", revision: 1 });
    const restored = await restart(f, "read-binding", project);
    expect(restored.choice).toEqual(cloudEnvironmentSelection(project, "account-a"));
    expect(restored.rows).toHaveLength(2);
    expect(await restart(f, "no-crash", project)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
  }
  expect(await restart(f, "set-override", "repo-successor", 0)).toMatchObject({ ok: false, conflict: true });
  expect(await restart(f, "set-override", "repo-successor", 1)).toMatchObject({ ok: true, binding: { revision: 2 } });
  expect(cloudEnvironmentSelection(f.input.project, "account-a").revision).toBe(2);
  expect(f.backend.calls.some(call => call.method === "POST")).toBe(false);
});

test("pending automatic setup retains its draft and operation after alias registration and restart", async () => {
  const options = { create: true, pending: true };
  const f = fixture(options);
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  const { persistProjectAliases } = await import("./aliases");
  expect(persistProjectAliases([{ source: f.input.project, target: "repo-successor", displayName: "Fixture" }])).toBe(true);
  options.pending = false; f.advance(2001);
  expect(await restart(f, "no-crash", "repo-successor")).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
});

for (const mismatch of ["repository", "ref"] as const) test(`automatic ${mismatch} invalidation creates one matching replacement across restart`, async () => {
  const f = fixture();
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  const prior = f.backend.configs.get("asenvcfg_account-a")!;
  prior.repositories = [{ repository_id: mismatch === "repository" ? "repo-other" : "repo-fixture", ref: mismatch === "ref" ? "other" : "main" }];
  expect(await restart(f)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a_replacement" });
  expect(await restart(f)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a_replacement" });
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
  expect(prior.repositories).toEqual([{ repository_id: mismatch === "repository" ? "repo-other" : "repo-fixture", ref: mismatch === "ref" ? "other" : "main" }]);
});

test("manual mismatches stay authoritative after restart without creating a replacement", async () => {
  const f = fixture({ ref: "other" });
  await setCloudEnvironmentOverride({ project: f.input.project, accountId: "account-a", environmentId: "asenvcfg_account-a", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("manual_environment_mismatched") });
  expect(cloudEnvironmentSelection(f.input.project, "account-a")).toMatchObject({ environmentId: "asenvcfg_account-a", revision: 1 });
  expect(f.backend.calls.some(call => call.method === "POST")).toBe(false);
});

test("a terminal failed approval restarts with a new idempotency key and the same configuration", async () => {
  const f = fixture({ create: true, failedApprovals: 1 });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
  expect(await restart(f)).toMatchObject({ state: "unavailable" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
  f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  const begins = f.backend.calls.filter(call => call.path.endsWith("approve/begin"));
  expect(begins).toHaveLength(2);
  expect(new Set(begins.map(call => call.body.idempotency_key)).size).toBe(2);
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
});

test("repeated terminal approval failures retain their cooldown budget across real restarts", async () => {
  const options = { create: true, failedApprovals: 3 };
  const f = fixture(options);
  for (const advance of [0, 2001, 4001]) {
    f.advance(advance);
    expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
  }
  f.advance(10_000);
  expect(await restart(f)).toMatchObject({ state: "unavailable" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(3);
  f.advance(15 * 60_000);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  const begins = f.backend.calls.filter(call => call.path.endsWith("approve/begin"));
  expect(new Set(begins.map(call => call.body.idempotency_key)).size).toBe(4);
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
});

test("a failed runtime observation leaves a RUNNING operation resumable", async () => {
  const options = { create: true, pending: true, operationPhaseFailed: true };
  const f = fixture(options);
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
  options.pending = false; options.operationPhaseFailed = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
});

test("alias pages merge predecessor and successor accounts without losing rows", async () => {
  const f = fixture();
  await f.prepare();
  await setCloudEnvironmentOverride({ project: f.input.project, accountId: "account-a", environmentId: "asenvcfg_account-a", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  const { persistProjectAliases } = await import("./aliases");
  expect(persistProjectAliases([{ source: f.input.project, target: "repo-successor", displayName: "Fixture" }])).toBe(true);
  await setCloudEnvironmentOverride({ project: "repo-successor", accountId: "account-b", environmentId: "asenvcfg_account-b", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  const rows = [];
  let after: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = readCloudEnvironmentBindings("repo-successor", { limit: 1, after });
    rows.push(...result.bindings);
    if (!result.nextCursor) break;
    after = result.nextCursor;
  }
  expect(rows.map(row => [row.accountId, row.kind])).toEqual([["account-a", "automatic"], ["account-a", "override"], ["account-b", "override"]]);
  expect(rows.every(row => row.project === "repo-successor")).toBe(true);
  expect(readCloudEnvironmentBindings(f.input.project, { accountId: "account-b" }).bindings).toHaveLength(1);
});

test("a created pending environment can be replaced after its ref changes without replaying its draft", async () => {
  const options = { create: true, pending: true };
  const f = fixture(options);
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  f.backend.configs.get("asenvcfg_account-a")!.repositories = [{ repository_id: "repo-fixture", ref: "other" }];
  options.pending = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a_replacement" });
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(2);
  const drafts = f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"));
  expect(drafts.map(call => call.path)).toEqual(["/v1/environment-configs/asenvcfg_account-a/drafts", "/v1/environment-configs/asenvcfg_account-a_replacement/drafts"]);
});

test("a lost reply to a fresh approval reuses its persisted retry key after restart", async () => {
  const f = fixture({ create: true, failedApprovals: 1 });
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  f.advance(2001);
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cloudEnvironmentRestart.fixture.ts"), f.backend.url,
    "/v1/environment-configs/asenvcfg_account-a/drafts/draft-fixture/approve/begin", String(f.input.now())],
    { env: { ...process.env, HOME: f.input.account.home, LLV_STATE_DIR: process.env.LLV_STATE_DIR! }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  const begins = f.backend.calls.filter(call => call.path.endsWith("approve/begin"));
  expect(begins).toHaveLength(3);
  expect(begins[1]!.body.idempotency_key).toBe(begins[2]!.body.idempotency_key);
  expect(begins[0]!.body.idempotency_key).not.toBe(begins[1]!.body.idempotency_key);
});

test("a terminal approval keeps its prerequisite reason and recovers after the prerequisite is restored", async () => {
  const options = { create: true, failedApprovals: 1, missingConnector: true };
  const f = fixture(options), original = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async (url, init) => {
    const response = await original(url, init);
    if (new URL(url).pathname.includes("/environment-operations/")) {
      const value = await response.json();
      return Response.json({ ...value, failure: { code: "github_connector_not_configured" } });
    }
    return response;
  };
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("github_connector_not_configured") });
  options.missingConnector = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(2);
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
});

test("creating environments on separate accounts keeps their configurations and approval receipts separate", async () => {
  const f = fixture({ create: true });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
  expect(await prepareCloudEnvironment({ ...f.input, account: { ...f.input.account, accountId: "account-b" } }, f.backend.dependencies))
    .toMatchObject({ state: "ready", environmentId: "asenvcfg_account-b" });
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs").map(call => call.account)).toEqual(["account-a", "account-b"]);
});

test("an alias registered between override admission and persistence cannot let two writers consume revision zero", async () => {
  const f = fixture();
  const { persistProjectAliases } = await import("./aliases");
  let peer: ReturnType<typeof setCloudEnvironmentOverride> | undefined;
  const write = { accountId: "account-a", expectedRevision: 0, actor: "operator" };
  const first = await setCloudEnvironmentOverride({ ...write, project: f.input.project, environmentId: "asenvcfg_first", assertCurrent: () => {
    if (peer) return;
    expect(persistProjectAliases([{ source: f.input.project, target: "repo-successor", displayName: "Fixture" }])).toBe(true);
    peer = setCloudEnvironmentOverride({ ...write, project: "repo-successor", environmentId: "asenvcfg_second", assertCurrent: () => {} });
  } });
  expect(peer).toBeDefined();
  const results = [first, await peer!];
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toHaveLength(1);
  expect(cloudEnvironmentSelection(f.input.project, "account-a")).toEqual(cloudEnvironmentSelection("repo-successor", "account-a"));
  expect(cloudEnvironmentSelection(f.input.project, "account-a").revision).toBe(1);
});
