import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stubCloudBackend } from "@/lib/pipelines/cloudEnvironment.fixture";
import { prepareCloudEnvironment, readCloudEnvironmentBindings, setCloudEnvironmentOverride, cloudEnvironmentSelection } from "./codexCloudEnvironments";
import { setCodexCloudEnvironmentId } from "./settings";

const roots: string[] = [], stops: (() => void)[] = [];
const previous = process.env.LLV_STATE_DIR;
afterEach(() => { for (const stop of stops.splice(0)) stop(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); process.env.LLV_STATE_DIR = previous; });
function fixture(options: Parameters<typeof stubCloudBackend>[0] = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-binding-")); roots.push(root); process.env.LLV_STATE_DIR = root;
  const backend = stubCloudBackend(options); stops.push(backend.stop);
  let clock = Date.UTC(2026, 9, 28);
  const input = { project: "repo-fixture", account: { engine: "codex" as const, accountId: "account-a", kind: "managed" as const, home: root, transcriptRoot: root, env: {} },
    repository: "sample/project", ref: "main", signal: new AbortController().signal, assertCurrent: () => {}, now: () => clock };
  return { backend, input, advance: (ms: number) => { clock += ms; }, prepare: () => prepareCloudEnvironment(input, backend.dependencies) };
}

test("empty project ID discovers the account's repository and ref and persists a ready binding", async () => {
  const f = fixture();
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
  const saved = readCloudEnvironmentBindings(f.input.project).bindings;
  expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ accountId: "account-a", state: "ready", source: "automatic", repository: "sample/project", ref: "main" });
  expect(f.backend.calls.some(c => c.method === "POST")).toBe(false);
});

test("creation checkpoints draft approval and checks runtime status before publishing readiness", async () => {
  const f = fixture({ create: true });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
  const posts = f.backend.calls.filter(c => c.method === "POST");
  expect(posts.map(c => c.path)).toEqual(["/v1/environment-configs", "/v1/environment-configs/asenvcfg_account-a/drafts",
    "/v1/environment-configs/asenvcfg_account-a/drafts/draft-fixture/approve/begin", "/v1/environment-configs/asenvcfg_account-a/drafts/draft-fixture/approve/complete"]);
  expect(posts[0]!.body).toMatchObject({ share_settings: "private", repositories: [{ repository_id: "repo-fixture", ref: "main" }], network_policy: { type: "restricted", presets: ["package_managers"] } });
  expect(f.backend.calls.some(c => c.method === "environment/status")).toBe(true);
});

test("a RUNNING approval cannot hide a missing workspace GitHub connection and private diagnostics stay inside the backend", async () => {
  const f = fixture({ create: true, missingConnector: true });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("github_connector_not_configured") });
  const saved = readCloudEnvironmentBindings(f.input.project);
  expect(saved.bindings[0]).toMatchObject({ state: "unavailable", code: "github_connector_not_configured" });
  expect(JSON.stringify(saved)).not.toContain("private-provider-value");
  expect(f.backend.calls.some(c => c.path.endsWith("approve/complete"))).toBe(false);
});

test("pending approval resumes the saved operation without a second create or draft", async () => {
  const f = fixture({ create: true, pending: true });
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  f.advance(2001);
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  expect(f.backend.calls.filter(c => c.method === "POST" && c.path === "/v1/environment-configs")).toHaveLength(1);
  expect(f.backend.calls.filter(c => c.path.endsWith("approve/begin"))).toHaveLength(1);
});

test("different accounts bind different IDs and manual overrides keep precedence through automatic refreshes", async () => {
  const f = fixture(); await f.prepare();
  const other = { ...f.input, account: { ...f.input.account, accountId: "account-b" } };
  expect(await prepareCloudEnvironment(other, f.backend.dependencies)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-b" });
  expect(setCodexCloudEnvironmentId(f.input.project, "asenvcfg_legacy")).toBe(true);
  const write = { project: f.input.project, accountId: "account-a", environmentId: "asenvcfg_account-a", expectedRevision: 0, actor: "operator", assertCurrent: () => {} };
  expect(await setCloudEnvironmentOverride(write)).toMatchObject({ ok: true });
  expect(cloudEnvironmentSelection(f.input.project, "account-a")).toMatchObject({ environmentId: "asenvcfg_account-a", source: "account-override" });
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(await setCloudEnvironmentOverride(write)).toMatchObject({ ok: false, conflict: true });
  expect(await setCloudEnvironmentOverride({ ...write, environmentId: null, expectedRevision: 1 })).toMatchObject({ ok: true });
  expect(cloudEnvironmentSelection(f.input.project, "account-a")).toMatchObject({ environmentId: "asenvcfg_legacy", source: "project-override" });
});

test("a matching display name or mount path never authorizes the wrong repository or ref", async () => {
  const f = fixture({ repository: "other/project" });
  expect(setCodexCloudEnvironmentId(f.input.project, "asenvcfg_account-a")).toBe(true);
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("manual_environment_mismatched") });
  expect(f.backend.calls.some(c => c.method === "POST")).toBe(false);
});

test("a manual edit while discovery is held withdraws all later remote effects", async () => {
  const f = fixture({ create: true });
  const original = f.backend.dependencies.fetch;
  let edited = false;
  f.backend.dependencies.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!edited) { edited = true; await setCloudEnvironmentOverride({ project: f.input.project, accountId: "account-a", environmentId: "asenvcfg_manual", expectedRevision: 0, actor: "operator", assertCurrent: () => {} }); }
    return response;
  };
  await expect(f.prepare()).rejects.toThrow("preparation_superseded");
  expect(f.backend.calls.some(c => c.method === "POST")).toBe(false);
});

for (const effect of ["/v1/environment-configs", "/v1/environment-configs/asenvcfg_account-a/drafts",
  "/v1/environment-configs/asenvcfg_account-a/drafts/draft-fixture/approve/begin", "/v1/environment-configs/asenvcfg_account-a/drafts/draft-fixture/approve/complete"])
  test(`a real process restart reconciles a lost reply after ${effect}`, async () => {
    const f = fixture({ create: true });
    const launch = async (crash: string) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cloudEnvironmentRestart.fixture.ts"), f.backend.url, crash, String(f.input.now())],
        { env: { ...process.env, HOME: f.input.account.home, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0); return stdout;
    };
    await launch(effect);
    const result = JSON.parse(await launch("no-crash"));
    expect(result).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
    expect(f.backend.calls.filter(c => c.method === "POST" && c.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(c => c.method === "POST" && c.path.endsWith("/drafts"))).toHaveLength(1);
    const begins = f.backend.calls.filter(c => c.path.endsWith("approve/begin"));
    expect(new Set(begins.map(c => c.body.idempotency_key)).size).toBe(1);
  });

test("a real process restart retains the setup deadline and cannot restart its creation budget", async () => {
  const f = fixture({ create: true, pending: true }); await f.prepare();
  f.advance(11 * 60_000);
  const before = f.backend.calls.length;
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cloudEnvironmentRestart.fixture.ts"), f.backend.url, "no-crash", String(f.input.now())],
    { env: { ...process.env, HOME: f.input.account.home, LLV_STATE_DIR: process.env.LLV_STATE_DIR! }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_deadline_exceeded") });
  expect(f.backend.calls).toHaveLength(before);
});

test("user and workspace catalogs follow both cursor spellings and find a later matching configuration", async () => {
  const f = fixture();
  const originalFetch = f.backend.dependencies.fetch; const catalogs: string[] = [];
  f.backend.dependencies.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.pathname === "/v1/environment-configs" && options.method === "GET") {
      catalogs.push(target.search);
      if (!target.searchParams.has("cursor")) return Response.json({ data: [], ...(target.searchParams.get("scope") === "user" ? { next_cursor: "later" } : { nextCursor: "later" }) });
    }
    return originalFetch(url, options);
  };
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(catalogs.filter(q => q.includes("cursor=later"))).toHaveLength(4);
});

test("an incomplete or repeated catalog cursor never establishes that creation is needed", async () => {
  const f = fixture({ create: true });
  f.backend.dependencies.fetch = async () => Response.json({ data: [], next_cursor: "again" });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("catalog_incomplete") });
  expect(f.backend.calls.some(c => c.method === "POST")).toBe(false);
});

for (const status of [401, 403]) test(`HTTP ${status} preserves the prerequisite without copying provider bodies or inventing a connector failure`, async () => {
  const f = fixture();
  f.backend.dependencies.fetch = async () => Response.json({ error: { message: "private-provider-value github_connector_not_configured" } }, { status });
  const result = await f.prepare();
  expect(result).toMatchObject({ state: "unavailable", reason: expect.stringContaining(status === 401 ? "authentication_expired" : "access_refused") });
  expect(JSON.stringify(result)).not.toContain("private-provider-value");
  expect(JSON.stringify(result)).not.toContain("github_connector_not_configured");
});

test("a manual edit during the create reply retains remote custody and never activates the stale automatic result", async () => {
  const f = fixture({ create: true });
  const originalFetch = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (options.method === "POST" && new URL(url).pathname === "/v1/environment-configs") {
      await setCloudEnvironmentOverride({ project: f.input.project, accountId: "account-a", environmentId: "asenvcfg_manual", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
    }
    return response;
  };
  await expect(f.prepare()).rejects.toThrow("preparation_superseded");
  expect(cloudEnvironmentSelection(f.input.project, "account-a")).toMatchObject({ environmentId: "asenvcfg_manual", source: "account-override" });
  expect(readCloudEnvironmentBindings(f.input.project).bindings.find(r => r.kind === "automatic")).toMatchObject({ state: "discovering", environmentId: "asenvcfg_manual" });
  expect(f.backend.calls.filter(c => c.method === "POST")).toHaveLength(1);
});

test("project aliases share bindings, account pages stay scoped, and a foreign cursor is refused", async () => {
  const f = fixture();
  const { persistProjectAliases } = await import("./aliases");
  expect(persistProjectAliases([{ source: "old-fixture", target: f.input.project, displayName: "Fixture" }])).toBe(true);
  await f.prepare();
  expect(readCloudEnvironmentBindings("old-fixture").bindings).toEqual(readCloudEnvironmentBindings(f.input.project).bindings);
  expect(readCloudEnvironmentBindings(f.input.project, { accountId: "account-b" }).bindings).toEqual([]);
  expect(() => readCloudEnvironmentBindings(f.input.project, { after: "foreign-project-cursor" })).toThrow("cursor");
});

test("concurrent override writers cannot both consume the same revision", async () => {
  const f = fixture();
  const common = { project: f.input.project, accountId: "account-a", expectedRevision: 0, actor: "operator", assertCurrent: () => {} };
  const results = await Promise.all([
    setCloudEnvironmentOverride({ ...common, environmentId: "asenvcfg_first" }),
    setCloudEnvironmentOverride({ ...common, environmentId: "asenvcfg_second" }),
  ]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok)).toHaveLength(1);
  expect(readCloudEnvironmentBindings(f.input.project).bindings[0]?.revision).toBe(1);
});

test("concurrent background and stage preparation reconcile one creation without forcing local fallback", async () => {
  const f = fixture({ create: true });
  const results = await Promise.all([f.prepare(), f.prepare()]);
  expect(results.some(result => result.state === "ready")).toBe(true);
  expect(results.some(result => result.state === "unavailable")).toBe(false);
  expect(f.backend.calls.filter(c => c.method === "POST" && c.path === "/v1/environment-configs")).toHaveLength(1);
});

test("a changed credential file revalidates the principal and preserves the old setup separately", async () => {
  const f = fixture(); await f.prepare();
  const old = readCloudEnvironmentBindings(f.input.project).bindings[0]!;
  fs.writeFileSync(path.join(f.input.account.home, "auth.json"), "{}");
  f.backend.dependencies.authenticate = async () => ({ token: "fixture-auth", account: "account-b" });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-b" });
  const current = readCloudEnvironmentBindings(f.input.project).bindings[0]!;
  expect(current.accountVersion).not.toBe(old.accountVersion);
  expect(current.environmentId).toBe("asenvcfg_account-b");
});

for (const elapsed of [2001, 20 * 60_000]) test(`restoring the GitHub prerequisite recovers the saved setup after ${elapsed}ms without another creation`, async () => {
  const options = { create: true, missingConnector: true };
  const f = fixture(options);
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  options.missingConnector = false; f.advance(elapsed);
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(c => c.method === "POST" && c.path === "/v1/environment-configs")).toHaveLength(1);
});
