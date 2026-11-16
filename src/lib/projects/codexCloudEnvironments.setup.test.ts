import { afterEach, expect, test } from "bun:test";
import { cloudEnvironmentTestContext } from "./codexCloudEnvironments.fixture";
import { deriveRepositorySetup } from "./cloudEnvironmentSetup";
import { readCloudEnvironmentBindings, setCloudEnvironmentOverride } from "./codexCloudEnvironments";
import { setCodexCloudEnvironmentId } from "./settings";

const { fixture, restart, cleanup } = cloudEnvironmentTestContext();
afterEach(cleanup);

test("creation sends the derived setup and approves its exact draft", async () => {
  const f = fixture({ create: true, setupFiles: { Dockerfile: "FROM node:22.16.0\nRUN npm install -g bun@1.4.0\n", "bun.lock": "" } });
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  const create = f.backend.calls.find(call => call.path === "/v1/environment-configs" && call.method === "POST")!;
  expect(create.body.install_script).toContain("bun install --frozen-lockfile");
  expect(create.body.install_script).toContain("v22.16.0");
  expect(f.backend.calls.some(call => call.path.endsWith("approve/complete"))).toBe(true);
});

test("an existing ready environment with no setup is repaired through one draft and approval", async () => {
  const f = fixture({ installScript: "" });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
  const patches = f.backend.calls.filter(call => call.method === "PATCH");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.body).toMatchObject({ expected_revision: 1, base_version_id: "version-two", install_script: expect.stringContaining("bun install --frozen-lockfile") });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))[0]!.body.expected_revision).toBe(2);
  expect(f.backend.calls.some(call => call.path === "/v1/environment-configs" && call.method === "POST")).toBe(false);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
});

test("an explicit selection with missing setup stays authoritative and names its missing steps", async () => {
  const f = fixture({ installScript: "" });
  expect(setCodexCloudEnvironmentId(f.input.project, "asenvcfg_account-a")).toBe(true);
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Selected environment requires setup: Bun 1.4.0") });
  expect(f.backend.calls.some(call => ["POST", "PATCH"].includes(call.method))).toBe(false);
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("bun install --frozen-lockfile") });
});

const operatorScripts = { "hand-written setup": "echo operator-setup\n", "edited generated setup": deriveRepositorySetup({ ".bun-version": "1.3.3" }).installScript + "echo operator-edit\n" };
for (const [kind, installScript] of Object.entries(operatorScripts))
  test(`${kind} is preserved with the missing steps`, async () => {
    const f = fixture({ installScript });
    expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Required setup: Bun 1.4.0") });
    expect(f.backend.configs.get("asenvcfg_account-a")!.install_script).toBe(installScript);
    expect(f.backend.calls.some(call => ["POST", "PATCH"].includes(call.method))).toBe(false);
    const row = (await restart(f, "read-binding")).rows[0];
    expect(row).toMatchObject({ state: "unavailable", reason: expect.stringContaining("bun install --frozen-lockfile") });
  });

test("an older generated setup is updated while start skill and network policy survive", async () => {
  const f = fixture({ installScript: deriveRepositorySetup({ ".bun-version": "1.3.3" }).installScript });
  await f.backend.dependencies.fetch("https://codex-cloud-backend.chatgpt.com/v1/environment-configs/asenvcfg_account-a", { method: "GET", headers: { "ChatGPT-Account-Id": "account-a" } });
  const config = f.backend.configs.get("asenvcfg_account-a")!;
  config.start_skill = "echo project-start"; config.network_policy = { type: "disabled" };
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(config).toMatchObject({ start_skill: "echo project-start", network_policy: { type: "disabled" }, install_script: expect.stringContaining('= "1.4.0"') });
});

test("missing pins retain a specific readiness reason across restart without provider effects", async () => {
  const f = fixture({ setupFiles: { "package.json": '{"engines":{"bun":">=1.4.0"}}', "bun.lock": "" } });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: "Repository declares no exact Bun version pin" });
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: "Repository declares no exact Bun version pin" });
  expect(f.backend.calls).toHaveLength(0);
  expect(readCloudEnvironmentBindings(f.input.project).bindings[0]!.reason).toBe("Repository declares no exact Bun version pin");
});

test("failed installation never publishes readiness and its reason survives restart", async () => {
  const f = fixture({ installScript: "", failedApprovals: 1 });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
  expect(f.backend.calls.some(call => call.path.endsWith("approve/complete"))).toBe(false);
  expect(readCloudEnvironmentBindings(f.input.project).bindings[0]!.state).toBe("unavailable");
});

for (const lost of ["/drafts", "/drafts/draft-fixture", "/drafts/draft-fixture/approve/begin", "/drafts/draft-fixture/approve/complete"])
  test(`repair resumes after a lost response to ${lost}`, async () => {
    const f = fixture({ installScript: "" });
    await restart(f, `/v1/environment-configs/asenvcfg_account-a${lost}`);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  });

test("pending repair keeps one operation across process restarts", async () => {
  const f = fixture({ installScript: "", pending: true });
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "pending" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
  expect(f.backend.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
});

test("a hand-written draft discovered during repair is preserved with its missing steps", async () => {
  const f = fixture({ installScript: "" }), original = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async (url, init) => {
    const response = await original(url, init);
    if (init.method === "POST" && new URL(url).pathname.endsWith("/drafts")) {
      const draft = f.backend.configs.get("asenvcfg_account-a")!.draft as Record<string, unknown>;
      draft.install_script = "echo operator-draft\n"; draft.revision = 2;
    }
    return response;
  };
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Required setup: Bun 1.4.0") });
  expect(f.backend.calls.some(call => call.method === "PATCH" || call.path.endsWith("approve/begin"))).toBe(false);
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Operator draft installScript preserved") });
});

test("an existing hand-written draft blocks repair before creating or approving another draft", async () => {
  const originalScript = "echo operator-owned setup\n";
  const f = fixture({ installScript: "", draftInstallScript: originalScript });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Required setup: Bun 1.4.0") });
  const config = f.backend.configs.get("asenvcfg_account-a")!;
  expect((config.draft as Record<string, unknown>).install_script).toBe(originalScript);
  expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(0);
  expect(f.backend.calls.some(call => call.method === "PATCH" || call.path.endsWith("/approve/begin")
    || call.path.endsWith("/approve/complete"))).toBe(false);
  expect(readCloudEnvironmentBindings(f.input.project).bindings[0]!.reason).toContain("Operator draft installScript preserved");
});

test("a concurrent operator draft edit refuses the expected revision before approval", async () => {
  const f = fixture({ installScript: "" }), original = f.backend.dependencies.fetch;
  let edited = false;
  f.backend.dependencies.fetch = async (url, init) => {
    const response = await original(url, init);
    if (!edited && init.method === "GET" && new URL(url).pathname.endsWith("/drafts/draft-fixture")) {
      edited = true;
      const draft = f.backend.configs.get("asenvcfg_account-a")!.draft as Record<string, unknown>;
      draft.install_script = "echo concurrent-operator-edit\n"; draft.revision = 2;
    }
    return response;
  };
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  expect((f.backend.configs.get("asenvcfg_account-a")!.draft as Record<string, unknown>).install_script).toBe("echo concurrent-operator-edit\n");
  expect(f.backend.calls.some(call => call.path.endsWith("approve/begin"))).toBe(false);
});

for (const boundary of ["snapshot", "patch"]) test(`authority withdrawn after the ${boundary} prevents approval`, async () => {
  const f = fixture({ installScript: "" });
  const withdraw = () => setCloudEnvironmentOverride({ project: f.input.project, accountId: f.input.account.accountId,
    environmentId: "asenvcfg_manual", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  if (boundary === "snapshot") {
    const read = f.backend.dependencies.repositorySetup!;
    f.backend.dependencies.repositorySetup = async (...args) => { const files = await read(...args); await withdraw(); return files; };
  } else {
    const original = f.backend.dependencies.fetch;
    f.backend.dependencies.fetch = async (url, init) => { const response = await original(url, init); if (init.method === "PATCH") await withdraw(); return response; };
  }
  await expect(f.prepare()).rejects.toThrow("preparation_superseded");
  expect(f.backend.calls.some(call => call.path.endsWith("approve/begin"))).toBe(false);
  if (boundary === "snapshot") expect(f.backend.calls).toHaveLength(0);
});
