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
  const input = { project: "repo-fixture", account: { engine: "codex" as const, accountId: "account-a", kind: "managed" as const, home: root, transcriptRoot: root, env: { NODE_ENV: "test" as const } },
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

async function restart(f: ReturnType<typeof fixture>, action = "no-crash", project = f.input.project, revision = 0) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cloudEnvironmentRestart.fixture.ts"), f.backend.url, action,
    String(f.input.now()), project, String(revision)], { env: { ...process.env, HOME: f.input.account.home, LLV_STATE_DIR: process.env.LLV_STATE_DIR!,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}

for (const effect of ["/v1/environment-configs", "/v1/environment-configs/asenvcfg_account-a/drafts"]) {
  test(`a held 403 refusal of ${effect} survives a peer checkpoint and recovers across restart`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    const dispatched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.backend.dependencies.fetch = async (url, init) => {
      if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
      dispatched.resolve();
      await release.promise;
      return Response.json({}, { status: 403 });
    };
    const held = f.prepare();
    try {
      await dispatched.promise;
      const before = readCloudEnvironmentBindings(f.input.project).bindings[0]!;
      expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
      expect(readCloudEnvironmentBindings(f.input.project).bindings[0]!.revision).toBeGreaterThan(before.revision);
    } finally { release.resolve(); }
    const refused = await held;
    f.backend.dependencies.fetch = original;
    const states = [];
    for (const elapsed of [2001, 4001, 900_001]) {
      f.advance(elapsed);
      states.push((await restart(f)).state);
    }
    expect(states).toEqual(["unavailable", "ready", "ready"]);
    expect(refused).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  test(`a held 403 refusal of ${effect} releases custody after cancellation and a peer checkpoint`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    const controller = new AbortController(); f.input.signal = controller.signal;
    const dispatched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.backend.dependencies.fetch = async (url, init) => {
      if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
      dispatched.resolve();
      await release.promise;
      return Response.json({}, { status: 403 });
    };
    const held = f.prepare().then(value => ({ value }), error => ({ error }));
    try {
      await dispatched.promise;
      expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
      controller.abort();
    } finally { release.resolve(); }
    expect(await held).toMatchObject({ error: { message: expect.stringContaining("access_refused") } });
    f.backend.dependencies.fetch = original; f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  test(`a late 403 refusal of ${effect} preserves a newer peer receipt across restart`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    const dispatched = Promise.withResolvers<() => Promise<Response>>(), release = Promise.withResolvers<void>();
    f.backend.dependencies.fetch = async (url, init) => {
      if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
      // Another remote writer can make a recoverable configuration/draft
      // visible while this caller is still waiting for its rejected request.
      dispatched.resolve(() => original(url, init));
      await release.promise;
      return Response.json({}, { status: 403 });
    };
    const held = f.prepare();
    let peer;
    try {
      const remoteWriter = await dispatched.promise;
      await remoteWriter();
      f.backend.dependencies.fetch = original;
      expect(await f.prepare()).toMatchObject({ state: "ready" });
      peer = readCloudEnvironmentBindings(f.input.project).bindings;
    } finally { release.resolve(); }
    expect(await held).toMatchObject({ state: "pending" });
    expect(readCloudEnvironmentBindings(f.input.project).bindings).toEqual(peer);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  for (const recovery of ["retry", "cooldown"] as const) {
    test(`a confirmed 403 refusal of ${effect} recovers after ${recovery} across restart`, async () => {
      const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
      let refused = 0;
      f.backend.dependencies.fetch = async (url, init) => {
        if (init.method === "POST" && new URL(url).pathname === effect) {
          refused++;
          return Response.json({ error: "access refused" }, { status: 403 });
        }
        return original(url, init);
      };
      for (const elapsed of recovery === "cooldown" ? [0, 2001, 4001] : [0]) {
        f.advance(elapsed);
        expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
        expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
      }
      expect(refused).toBe(recovery === "cooldown" ? 3 : 1);
      f.backend.dependencies.fetch = original;
      if (recovery === "cooldown") {
        f.advance(10_000);
        expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
      }
      f.advance(recovery === "cooldown" ? 900_001 : 2001);
      expect(await restart(f)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
      expect(await restart(f)).toMatchObject({ state: "ready" });
      expect(f.backend.configs.size).toBe(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
    });
  }

  for (const responseKind of ["empty", "invalid", "broken", "authentication"] as const) {
    test(`a ${responseKind} rejection response from ${effect} still permits recovery across restart`, async () => {
      const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
      f.backend.dependencies.fetch = async (url, init) => {
        if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
        if (responseKind === "empty") return new Response(null, { status: 403 });
        if (responseKind === "invalid") return new Response("invalid fixture JSON", { status: 403 });
        if (responseKind === "broken") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture body failure")); } }), { status: 403 });
        return Response.json({}, { status: 401 });
      };
      expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining(responseKind === "authentication" ? "authentication_expired" : "access_refused") });
      f.advance(2001);
      expect(await restart(f)).toMatchObject({ state: "ready" });
      expect(f.backend.configs.size).toBe(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
    });
  }

  for (const reply of ["transport", "server", "invalid"] as const) test(`a ${reply} failure from ${effect} retains custody after a later 403 read and cooldown across restart`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    f.backend.dependencies.fetch = async (url, init) => {
      const response = await original(url, init);
      if (init.method === "POST" && new URL(url).pathname === effect) {
        if (reply === "transport") throw new Error("fixture lost reply");
        if (reply === "server") return Response.json({}, { status: 500 });
        return new Response("invalid fixture JSON");
      }
      return response;
    };
    expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
    f.backend.dependencies.fetch = async () => Response.json({}, { status: 403 });
    f.advance(2001);
    expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
    const config = f.backend.configs.get("asenvcfg_account-a")!;
    const draft = config.draft;
    if (effect.endsWith("/drafts")) delete config.draft;
    else f.backend.configs.delete("asenvcfg_account-a");
    f.backend.dependencies.fetch = original;
    for (const elapsed of [4001, 900_001]) {
      f.advance(elapsed);
      expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
    }
    if (effect.endsWith("/drafts")) config.draft = draft;
    else f.backend.configs.set("asenvcfg_account-a", config);
    f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });
}

for (const manual of ["ready", "missing", "mismatched"] as const) test(`legacy manual Cloud selection stays ${manual} through aliases and real restarts`, async () => {
  const f = fixture();
  if (manual !== "missing") f.backend.configs.set("asenvcfg_manual", { id: "asenvcfg_manual",
    repositories: [{ repository_id: "repo-fixture", ref: manual === "mismatched" ? "other" : "main" }],
    version_id: "version-manual", latest_ready_version_id: "version-manual", version_revision: 1, share_settings: "private" });
  expect(setCodexCloudEnvironmentId(f.input.project, "asenvcfg_manual")).toBe(true);
  const { persistProjectAliases } = await import("./aliases");
  expect(persistProjectAliases([{ source: f.input.project, target: "repo-successor", displayName: "Fixture" }])).toBe(true);
  const expected = manual === "ready" ? { state: "ready", environmentId: "asenvcfg_manual" }
    : { state: "unavailable", reason: expect.stringContaining(manual === "missing" ? "environment_missing" : "manual_environment_mismatched") };
  for (const project of [f.input.project, "repo-successor"]) {
    expect(cloudEnvironmentSelection(project, "account-a")).toMatchObject({ environmentId: "asenvcfg_manual", source: "project-override" });
    expect((await restart(f, "read-binding", project)).choice).toMatchObject({ environmentId: "asenvcfg_manual", source: "project-override" });
    expect(await prepareCloudEnvironment({ ...f.input, project }, f.backend.dependencies)).toMatchObject(expected);
    expect(await restart(f, "no-crash", project)).toMatchObject(expected);
  }
  expect(f.backend.calls.some(call => call.path === "/v1/environment-configs/asenvcfg_manual")).toBe(true);
  expect(f.backend.calls.some(call => call.path.startsWith("/v1/environment-configs?"))).toBe(false);
  expect(f.backend.calls.some(call => call.method === "POST")).toBe(false);
});

for (const runtimeStatus of ["missing", "error", "invalid", "foreign"] as const) {
  test(`terminal approval failure retires its receipt when runtime status is ${runtimeStatus} across restart`, async () => {
    const options: NonNullable<Parameters<typeof stubCloudBackend>[0]> = { create: true, failedApprovals: 1, runtimeStatus };
    const f = fixture(options);
    expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
    expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
    expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
    delete options.runtimeStatus;
    f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(await restart(f)).toMatchObject({ state: "ready" });
    const begins = f.backend.calls.filter(call => call.path.endsWith("approve/begin"));
    expect(begins).toHaveLength(2);
    expect(new Set(begins.map(call => call.body.idempotency_key)).size).toBe(2);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  test(`a RUNNING approval keeps its receipt when runtime status is ${runtimeStatus} across restart`, async () => {
    const options: NonNullable<Parameters<typeof stubCloudBackend>[0]> = { create: true, pending: true, runtimeStatus };
    const f = fixture(options);
    expect(await restart(f)).toMatchObject({ state: "unavailable" });
    delete options.runtimeStatus;
    f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "pending" });
    options.pending = false; f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
  });
}

for (const field of ["id", "environment_id"] as const) test(`an unconfirmed FAILED operation with a foreign ${field} keeps its receipt across restart`, async () => {
  const options = { create: true, pending: true };
  const f = fixture(options), original = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async (url, init) => {
    const response = await original(url, init);
    return new URL(url).pathname.includes("/environment-operations/")
      ? Response.json({ ...await response.json(), state: "FAILED", [field]: "foreign-instance" }) : response;
  };
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("configuration_invalid") });
  f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "pending" });
  options.pending = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
});

test("a terminal approval uses matching runtime diagnostics and retires the failed operation", async () => {
  const options = { create: true, failedApprovals: 1, missingConnector: true };
  const f = fixture(options);
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("github_connector_not_configured") });
  options.missingConnector = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(2);
});

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
