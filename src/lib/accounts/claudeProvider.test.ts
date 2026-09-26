import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { hardenedRedact } from "@/lib/view/compactText";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-provider-test-"));
const oldState = process.env.LLV_STATE_DIR;
const oldHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "main");

const accounts = await import("./claude");
const { accountManager } = await import("./manager");
const { freshSpecFor, resumeSpecForSession, resolveBinary } = await import("@/lib/agent/cli");
const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
const { applyClaudeSpawnPolicy } = await import("@/lib/agent/spawnPolicy");
const { selectHealthyClaudeAccount } = await import("./spawnHealth");
const { readClaudeAccountLimits } = await import("@/lib/limits");
const { reviewerCommand } = await import("@/lib/agent/headless");
const { claudeQuotaObservation } = await import("@/lib/accounts/migration/quotaController");

const token = "local-provider-fixture-token";
const provider = { baseUrl: "http://127.0.0.1:9876", model: "model-large", smallFastModel: "model-small" };

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "shared"), { recursive: true, force: true });
});
afterAll(() => {
  if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
  if (oldHome === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = oldHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("provider account token is private and scoped through manager and production launch builders", async () => {
  const added = accounts.createManagedClaudeAccount("Provider", { config: provider, token });
  const oauth = accounts.createManagedClaudeAccount("OAuth");
  expect(fs.statSync(path.join(added.home, ".provider-token")).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(added.home, ".provider-runtime")).mode & 0o777).toBe(0o600);
  expect(accounts.listClaudeAccounts().find((account) => account.id === added.id)).toMatchObject({ authPresent: true, provider });
  expect(JSON.stringify(accounts.listClaudeAccounts())).not.toContain(token);
  expect(JSON.stringify(await accountManager.list())).not.toContain(token);

  const context = accountManager.resolveSpawn("claude", added.id);
  const other = accountManager.resolveSpawn("claude", oauth.id);
  expect(context.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
  expect(context.env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
  expect(other.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(other.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(other.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(accounts.claudeManagedEnvironment(oauth.home, { NODE_ENV: "test", ANTHROPIC_MODEL: "operator-choice", ANTHROPIC_AUTH_TOKEN: "inherited" }).ANTHROPIC_MODEL).toBe("operator-choice");

  const fresh = freshSpecFor("claude", sandbox, { claudeConfigDir: added.home, model: "opus" });
  if (!fresh.launchProfile) throw new Error("fresh launch profile missing");
  const resumed = resumeSpecForSession("claude", "12345678-1234-1234-1234-123456789abc", sandbox, added.home, { model: "haiku" });
  expect(fresh.command).toContain("model-large");
  expect(resumed?.command).toContain("model-small");
  expect(fresh.command).not.toContain(token);
  expect(resumed?.command).not.toContain(token);
  expect(fresh.command).toContain("claude-provider-launch.mjs");
  expect(freshSpecFor("claude", sandbox, { claudeConfigDir: oauth.home }).command).not.toContain("-u ANTHROPIC_MODEL");
  const mcpConfigPath = fresh.command.match(/'--mcp-config' '([^']+)'/)?.[1];
  expect(mcpConfigPath).toBeTruthy();
  expect(fs.readFileSync(mcpConfigPath!, "utf8")).not.toContain(token);

  const launch = claudeStructuredHostOptions({ spec: fresh, account: context }, { env: context.env, host: {} });
  const resumeLaunch = claudeStructuredHostOptions({ spec: { ...fresh, launchProfile: { ...fresh.launchProfile, model: "haiku" } }, account: context }, { env: context.env, host: {} });
  const oauthLaunch = claudeStructuredHostOptions({ spec: fresh, account: other }, { env: other.env, host: {} });
  expect(launch).toMatchObject({ providerAccount: true, model: "model-large", claudeConfigDir: added.home });
  expect(launch.mcpServers).toContain("viewer");
  expect(resumeLaunch).toMatchObject({ providerAccount: true, model: "model-small" });
  expect(oauthLaunch).toMatchObject({ providerAccount: false, model: "opus" });
  expect(JSON.stringify({ ...launch, env: undefined })).not.toContain(token);
});

test("provider edits rotate the private token while keeping public configuration secret-free", () => {
  const added = accounts.createManagedClaudeAccount("Provider", { config: provider, token });
  const edited = accounts.updateProviderClaudeAccount(added.id, { ...provider, model: "next-model", smallFastModel: null }, "rotated-fixture-token", "Renamed");
  expect(edited).toMatchObject({ label: "Renamed", authPresent: true, provider: { model: "next-model", smallFastModel: null } });
  expect(accounts.readClaudeProviderToken(added.home)).toBe("rotated-fixture-token");
  expect(fs.statSync(path.join(added.home, ".provider-token")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(accounts.listClaudeAccounts())).not.toContain("rotated-fixture-token");
});

test("endpoint edits never pair a new token with an old endpoint during the atomic runtime swap", () => {
  const added = accounts.createManagedClaudeAccount("Atomic", { config: provider, token });
  const oldCommand = freshSpecFor("claude", sandbox, { claudeConfigDir: added.home, model: "opus" }).command;
  const changed = { ...provider, baseUrl: "http://127.0.0.1:9877" };
  const replacement = "replacement-provider-token-8427";
  const rename = fs.renameSync;
  let checked = false;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    rename(source, target);
    if (String(target) === path.join(added.home, ".provider-runtime") && !checked) {
      checked = true;
      expect(() => accounts.claudeAccountEnvironment(added)).toThrow();
      expect(() => accounts.readClaudeProviderRuntime(added.home, added.provider)).toThrow();
    }
  }) as typeof fs.renameSync;
  let edited: typeof added;
  try { edited = accounts.updateProviderClaudeAccount(added.id, changed, replacement); }
  finally { fs.renameSync = rename; }
  expect(checked).toBe(true);
  expect(accounts.claudeAccountEnvironment(edited).ANTHROPIC_BASE_URL).toBe(changed.baseUrl);
  expect(accounts.claudeAccountEnvironment(edited).ANTHROPIC_AUTH_TOKEN).toBe(replacement);
  const fake = path.join(sandbox, "atomic-fake-claude");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const stale = spawnSync("sh", ["-c", oldCommand.replace(`'${resolveBinary("claude")}'`, `'${fake}'`)], { cwd: sandbox, env: process.env });
  expect(stale.status).toBe(1);
  expect(stale.stderr.toString()).not.toContain(replacement);
});

test("retained ordinary transcript text keeps old provider secrets redacted after rotation and removal", () => {
  const oldHeader = "ordinary-header-secret-8427";
  const newToken = ["replacement", "provider", "token", "8427"].join("-");
  const newHeader = ["replacement", "header", "secret", "8427"].join("-");
  const added = accounts.createManagedClaudeAccount("Retained", { config: provider, token, headers: { "x-feature": oldHeader } });
  const text = `ordinary transcript text ${token} and ${oldHeader} remains readable`;
  accounts.updateProviderClaudeAccount(added.id, provider, newToken, undefined, { "x-feature": newHeader });
  expect(hardenedRedact(text)).toBe("ordinary transcript text [redacted] and [redacted] remains readable");
  fs.chmodSync(added.home, 0o000);
  try { expect(hardenedRedact(`ordinary ${newToken} and ${newHeader} text`)).toBe("ordinary [redacted] and [redacted] text"); }
  finally { fs.chmodSync(added.home, 0o700); }
  fs.writeFileSync(path.join(added.home, "history.jsonl"), text);
  accounts.removeManagedClaudeAccount(added.id);
  expect(hardenedRedact(text)).toBe("ordinary transcript text [redacted] and [redacted] remains readable");
  const fingerprints = fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "provider-redaction.json"), "utf8");
  expect(fingerprints).not.toContain(token);
  expect(fingerprints).not.toContain(oldHeader);
  expect(fs.statSync(path.join(process.env.LLV_STATE_DIR!, "provider-redaction.key")).mode & 0o777).toBe(0o600);
});

test("provider redaction marker stays stable when the token itself spells redacted", () => {
  const account = accounts.createManagedClaudeAccount("Marker", { config: provider, token: "redacted" });
  expect(hardenedRedact("begin redacted end")).toBe("begin [withheld] end");
  accounts.updateProviderClaudeAccount(account.id, provider, "replacement-token-8427");
  expect(hardenedRedact("begin redacted end")).toBe("begin [withheld] end");
});

test("damaged private credentials report an account error and accept explicit repair", async () => {
  const added = accounts.createManagedClaudeAccount("Repair", { config: provider, token, headers: { "x-feature": "private-feature-8427" } });
  const headersFile = path.join(added.home, ".provider-headers");
  fs.chmodSync(headersFile, 0o644);
  expect(hardenedRedact(`ordinary ${token} private-feature-8427 text`)).toBe("ordinary [redacted] [redacted] text");
  await expect(selectHealthyClaudeAccount([added], added.id)).rejects.toThrow("credentials and headers");
  expect(await claudeQuotaObservation(added, Date.now())).toMatchObject({ authenticated: false, provenance: { reason: "provider credentials require repair" } });
  const fixedHeaders = accounts.updateProviderClaudeAccount(added.id, provider, undefined, undefined, { "x-feature": "replacement-feature-8427" });
  expect(fixedHeaders.provider?.customHeaderNames).toEqual(["x-feature"]);
  expect(fs.statSync(headersFile).mode & 0o777).toBe(0o600);
  expect(accounts.readClaudeProviderHeaders(added.home)).toEqual({ "x-feature": "replacement-feature-8427" });
  fs.rmSync(headersFile);
  await expect(selectHealthyClaudeAccount([added], added.id)).rejects.toThrow("credentials and headers");
  expect(() => accounts.updateProviderClaudeAccount(added.id, provider, undefined, "Renamed")).toThrow();
  accounts.updateProviderClaudeAccount(added.id, provider, undefined, undefined, { "x-feature": "repaired-feature-8427" });
  fs.rmSync(path.join(added.home, ".provider-token"));
  const fixedToken = accounts.updateProviderClaudeAccount(added.id, provider, "replacement-provider-token-8427");
  expect(fixedToken.authPresent).toBe(true);
  expect(accounts.readClaudeProviderToken(added.home)).toBe("replacement-provider-token-8427");
});

test("provider removal scrubs token and header files from the retained history archive", () => {
  const added = accounts.createManagedClaudeAccount("Archived", { config: provider, token, headers: { "x-feature": "private-feature-8427" } });
  fs.writeFileSync(path.join(added.home, "history.jsonl"), "retained conversation history\n");
  const removal = accounts.removeManagedClaudeAccount(added.id);
  expect(removal.cleanupPending).toBe(false);
  expect(fs.readFileSync(path.join(removal.archive!, "history.jsonl"), "utf8")).toBe("retained conversation history\n");
  expect(fs.existsSync(path.join(removal.archive!, ".provider-token"))).toBe(false);
  expect(fs.existsSync(path.join(removal.archive!, ".provider-headers"))).toBe(false);
  expect(fs.existsSync(path.join(removal.archive!, ".provider-runtime"))).toBe(false);
});

test("interrupted provider credential cleanup is completed by removal recovery", () => {
  const added = accounts.createManagedClaudeAccount("Recovery", { config: provider, token, headers: { "x-feature": "private-feature-8427" } });
  fs.writeFileSync(path.join(added.home, "history.jsonl"), "retained conversation history\n");
  const unlink = fs.unlinkSync;
  fs.unlinkSync = ((filename: fs.PathLike) => {
    if (path.basename(String(filename)) === ".provider-token") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return unlink(filename);
  }) as typeof fs.unlinkSync;
  let removal: ReturnType<typeof accounts.removeManagedClaudeAccount>;
  try { removal = accounts.removeManagedClaudeAccount(added.id); }
  finally { fs.unlinkSync = unlink; }
  expect(removal.cleanupPending).toBe(true);
  expect(fs.existsSync(path.join(removal.archive!, ".provider-token"))).toBe(true);
  expect(accounts.recoverInterruptedClaudeAccountRemovals()).toEqual({ recovered: [added.id], unresolved: [] });
  expect(fs.existsSync(path.join(removal.archive!, ".provider-token"))).toBe(false);
  expect(fs.existsSync(path.join(removal.archive!, ".provider-headers"))).toBe(false);
  expect(fs.readFileSync(path.join(removal.archive!, "history.jsonl"), "utf8")).toBe("retained conversation history\n");
}, 20_000);

test("provider headers stay private and shared settings cannot replace its routing", () => {
  const headerSecret = ["opaque", "local", "header", "value", "8427"].join("-");
  const added = accounts.createManagedClaudeAccount("Provider", { config: provider, token, headers: { "x-provider-feature": headerSecret } });
  expect(fs.statSync(path.join(added.home, ".provider-headers")).mode & 0o777).toBe(0o600);
  expect(added.provider?.customHeaderNames).toEqual(["x-provider-feature"]);
  expect(JSON.stringify(added)).not.toContain(headerSecret);
  expect(accounts.readClaudeProviderHeaders(added.home)).toEqual({ "x-provider-feature": headerSecret });
  const shared = path.join(sandbox, "shared-settings.json");
  fs.writeFileSync(shared, JSON.stringify({ apiKeyHelper: "echo wrong", model: "wrong-model", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "wrong", SAFE: "yes" } }));
  const policy = applyClaudeSpawnPolicy(added.home, { baseSettingsPath: shared, providerAccount: true });
  const settings = JSON.parse(fs.readFileSync(policy.settingsPath, "utf8")) as { env: Record<string, string> };
  expect(settings.env).toEqual({ SAFE: "yes" });
  expect(settings).not.toHaveProperty("apiKeyHelper");
  expect(settings).not.toHaveProperty("model");
  expect(fs.readFileSync(policy.settingsPath, "utf8")).not.toContain(token);
  expect(hardenedRedact(`error: ${token}; ${headerSecret}; ordinary text`)).toBe("error: [redacted]; [redacted]; ordinary text");
});

test("OpenCode Go catalog offers documented Messages routes and validates both launch models", async () => {
  const go = { baseUrl: "https://opencode.ai/zen/go", model: "qwen3.8-max", smallFastModel: "qwen3.8-flash" };
  const mixed = ["gpt-6-luna", "qwen3.8-max", "grok-4.7", "qwen3.8-flash", "minimax-m3"];
  expect(accounts.claudeProviderModelChoices(go, mixed)).toEqual(["qwen3.8-max", "qwen3.8-flash", "minimax-m3"]);
  expect(accounts.claudeProviderModelChoices(provider, mixed)).toEqual(mixed);
  expect(() => accounts.validateClaudeProviderHeaders({ "x-feature": "1" })).toThrow("at least eight");
  expect(() => accounts.validateClaudeProviderModelRoute(go)).not.toThrow();
  expect(() => accounts.validateClaudeProviderModelRoute({ ...go, model: "gpt-6-luna" })).toThrow("Anthropic Messages");
  expect(() => accounts.validateClaudeProviderModelRoute({ ...go, smallFastModel: "grok-4.7" })).toThrow("Anthropic Messages");
  const fetchBefore = globalThis.fetch;
  const captured: { headers?: Headers } = {};
  try {
    globalThis.fetch = (async (_input, init) => {
      captured.headers = new Headers(init?.headers);
      return Response.json({ data: mixed.map((id) => ({ id })) });
    }) as typeof fetch;
    expect(await accounts.listClaudeProviderModels(go, token)).toEqual(["qwen3.8-max", "qwen3.8-flash", "minimax-m3"]);
  } finally { globalThis.fetch = fetchBefore; }
  expect(captured.headers?.get("x-opencode-session")).toMatch(/^[0-9a-f-]{36}$/);
  expect(captured.headers?.get("user-agent")).toContain("Delegatus");
  const account = accounts.createManagedClaudeAccount("Go", { config: go, token });
  expect(account.provider).toMatchObject({ model: "qwen3.8-max", smallFastModel: "qwen3.8-flash" });
});

test("generic model catalog drops JSON-escaped echoes of the provider credential", async () => {
  const quoted = 'abc"defgh';
  const fetchBefore = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ data: [
      { id: JSON.stringify(quoted).slice(1, -1) }, { id: "safe-model" },
    ] })) as typeof fetch;
    expect(await accounts.listClaudeProviderModels(provider, quoted)).toEqual(["safe-model"]);
  } finally { globalThis.fetch = fetchBefore; }
});

test("catalog and retained transcript reads remove slash-escaped credentials", async () => {
  const slashToken = "abcde123/";
  const fetchBefore = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ data: [{ id: "abcde123\\/" }, { id: "safe-model" }] })) as typeof fetch;
    expect(await accounts.listClaudeProviderModels(provider, slashToken)).toEqual(["safe-model"]);
  } finally { globalThis.fetch = fetchBefore; }
  const account = accounts.createManagedClaudeAccount("Slash", { config: provider, token: slashToken });
  accounts.updateProviderClaudeAccount(account.id, provider, "replacement-token-8427");
  expect(hardenedRedact("ordinary abcde123\\/ text")).toBe("ordinary [redacted] text");
});

test("retained transcript redaction maps Unicode-escaped credential spans", () => {
  const account = accounts.createManagedClaudeAccount("Unicode", { config: provider, token });
  const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  accounts.updateProviderClaudeAccount(account.id, provider, "replacement-token-8427");
  expect(hardenedRedact(`ordinary ${encoded} text`)).toBe("ordinary [redacted] text");
  expect(hardenedRedact(`ordinary ${token} and ${encoded} text`)).toBe("ordinary [redacted] and [redacted] text");
});

test("tmux command gives Claude a private relay alias without putting the provider token in argv", () => {
  const account = accounts.createManagedClaudeAccount("Provider", { config: provider, token });
  const fakeHome = path.join(sandbox, "fake-home");
  const binary = path.join(fakeHome, ".bun", "bin", "claude");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\n[ \"$ANTHROPIC_AUTH_TOKEN\" != \"$EXPECTED_TOKEN\" ] && [ \"$ANTHROPIC_MODEL\" = model-large ] && case \"$ANTHROPIC_BASE_URL\" in http://127.0.0.1:*) exit 0;; *) exit 1;; esac\n", { mode: 0o700 });
  const command = freshSpecFor("claude", sandbox, { claudeConfigDir: account.home, model: "opus" }).command
    .replace(`'${resolveBinary("claude")}'`, `'${binary}'`);
  expect(command).not.toContain(token);
  expect(command).toContain("claude-provider-launch.mjs");
  expect(command).toContain(binary);
  const result = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: fakeHome, EXPECTED_TOKEN: token }, cwd: sandbox, timeout: 15_000 });
  expect({ status: result.status, stderr: result.stderr.toString() }).toEqual({ status: 0, stderr: "" });
}, 20_000);

test("direct fresh and resumed production commands reach only the selected provider with session headers", async () => {
  const received: Array<{ auth: string | null; session: string | null; feature: string | null }> = [];
  const wrong: string[] = [];
  const a = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    received.push({ auth: request.headers.get("authorization"), session: request.headers.get("x-opencode-session"), feature: request.headers.get("x-feature") });
    return Response.json({ ok: true });
  } });
  const b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { wrong.push(new URL(request.url).pathname); return Response.json({ ok: false }); } });
  try {
    fs.mkdirSync(process.env.LLV_CLAUDE_HOME!, { recursive: true });
    fs.writeFileSync(path.join(process.env.LLV_CLAUDE_HOME!, "settings.json"), JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${b.port}`, ANTHROPIC_AUTH_TOKEN: "wrong",
    } }));
    const account = accounts.createManagedClaudeAccount("Direct", { config: { ...provider, baseUrl: `http://127.0.0.1:${a.port}` },
      token, headers: { "x-feature": "private-feature-8427" } });
    const fake = path.join(sandbox, "fake-claude");
    fs.writeFileSync(fake, `#!/usr/bin/env bun\nconst response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "user-agent": "claude-cli/fixture" } }); process.exit(response.ok ? 0 : 1);\n`, { mode: 0o700 });
    const run = async (command: string) => {
      const child = spawn("sh", ["-c", command.replace(`'${resolveBinary("claude")}'`, `'${fake}'`)], { cwd: sandbox, env: process.env, stdio: "ignore" });
      const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect(status).toBe(0);
    };
    const fresh = freshSpecFor("claude", sandbox, { claudeConfigDir: account.home, model: "opus" });
    const sessionId = path.basename(fresh.transcript!, ".jsonl");
    await run(fresh.command);
    const resumed = resumeSpecForSession("claude", sessionId, sandbox, account.home, { model: "haiku" });
    expect(resumed).not.toBeNull();
    await run(resumed!.command);
    expect(received).toEqual([
      { auth: `Bearer ${token}`, session: sessionId, feature: "private-feature-8427" },
      { auth: `Bearer ${token}`, session: sessionId, feature: "private-feature-8427" },
    ]);
    expect(wrong).toEqual([]);
    expect(fresh.command).not.toContain(token);
    expect(resumed!.command).not.toContain(token);
  } finally { a.stop(); b.stop(); }
});

test("headless Claude reviewer uses the selected provider through the private launcher", () => {
  const account = accounts.createManagedClaudeAccount("Headless", { config: provider, token, headers: { "x-feature": "private-feature-8427" } });
  const built = reviewerCommand({ engine: "claude", model: "haiku", effort: null }, "Review the change", path.join(sandbox, "review.md"), sandbox,
    null, { home: account.home, projectsDir: account.projectsDir, managed: true });
  expect(built.command).toBe("bun");
  expect(built.args).toContain(path.join(account.home, ".llv", "claude-provider-launch.mjs"));
  expect(built.args).toContain("model-small");
  expect(built.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(built.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(JSON.stringify(built)).not.toContain(token);
  const settings = fs.readFileSync(built.args[built.args.indexOf("--settings") + 1]!, "utf8");
  expect(settings).not.toContain(token);
});

test("headless reviewer launch reaches the account provider with its stable session header", async () => {
  const seen: { value?: { auth: string | null; session: string | null; feature: string | null } } = {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.value = { auth: request.headers.get("authorization"), session: request.headers.get("x-opencode-session"), feature: request.headers.get("x-feature") };
    return Response.json({ ok: true });
  } });
  try {
    const account = accounts.createManagedClaudeAccount("Headless", { config: { ...provider, baseUrl: `http://127.0.0.1:${server.port}` },
      token, headers: { "x-feature": "private-feature-8427" } });
    const built = reviewerCommand({ engine: "claude", model: "haiku", effort: null }, "Review", path.join(sandbox, "review.md"), sandbox,
      null, { home: account.home, projectsDir: account.projectsDir, managed: true });
    const fake = path.join(sandbox, "fake-headless-claude");
    fs.writeFileSync(fake, `#!/usr/bin/env bun\nconst response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "user-agent": "claude-cli/fixture" } }); process.exit(response.ok ? 0 : 1);\n`, { mode: 0o700 });
    const args = built.args.map((value) => value === resolveBinary("claude") ? fake : value);
    const child = spawn(built.command, args, { cwd: sandbox, env: built.env, stdio: "ignore" });
    const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect(status).toBe(0);
    expect(seen.value).toEqual({ auth: `Bearer ${token}`, session: built.sessionId, feature: "private-feature-8427" });
  } finally { server.stop(); }
});

test("provider health admits unknown limits and reports its own authentication failure", async () => {
  let status = 200;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return status === 200 ? Response.json({ data: [{ id: "model-large" }] }) : new Response(null, { status });
  } });
  try {
    const account = accounts.createManagedClaudeAccount("Provider", {
      config: { ...provider, baseUrl: `http://127.0.0.1:${server.port}` }, token,
    });
    const healthy = await selectHealthyClaudeAccount([account], account.id);
    expect(healthy.account.id).toBe(account.id);
    expect(healthy.admission).toMatchObject({ kind: "admissible" });
    expect(await readClaudeAccountLimits(account)).toMatchObject({ data: null, provenance: { reason: "provider limits unknown" } });
    status = 503;
    expect((await selectHealthyClaudeAccount([account], account.id)).admission).toMatchObject({ kind: "admissible", basis: "last-known" });
    await expect(claudeQuotaObservation(account, Date.now())).rejects.toThrow("quota-auth-indeterminate");
    status = 404;
    expect((await selectHealthyClaudeAccount([account], account.id)).admission).toMatchObject({ kind: "admissible", basis: "last-known" });
    status = 401;
    await expect(selectHealthyClaudeAccount([account], account.id)).rejects.toThrow("Check the provider credentials and headers for Provider");
  } finally { server.stop(); }
});
