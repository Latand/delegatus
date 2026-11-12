import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import type { NextRequest } from "next/server";

import { internalServiceHeaders } from "./operatorAuthority";
import { ensureOperatorSpawnCapability } from "./operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./spawnPolicy";
import { AgentRegistry } from "./registry";
import { executeSpawnRequest, type SpawnCommandDependencies } from "./spawnCommand";
import { parseCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";
import { setCodexShellPolicyReaderForTest } from "@/lib/git/codexShellPolicy";
import { loadRoleOverrides, saveRoleOverrides } from "@/lib/roles/store";
import { CodexAppServerHost, type CodexAppServerHostOptions } from "@/lib/runtime/codexAppServerHost";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { defaultStartHost, structuredHostWorkingDirectory, materializeStructuredHostAccess, structuredHostAccessPolicy } from "@/lib/runtime/structuredSpawn";
import { CLEANER_SANDBOX_READY } from "@/lib/runtime/cleanerSandboxProbe";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cleaner-launch-"));
const env = {
  LLV_STATE_DIR: path.join(root, "state"), HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"),
  LLV_SPAWN_TRANSPORT: "structured", LLV_RUNTIME_HOST_SOCKET: path.join(root, "host.sock"),
  LLV_STRUCTURED_HOSTS: "1", LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
  LLV_CODEX_BINARY: path.join(root, "codex-list"),
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.TMPDIR, path.join(root, "codex")]) fs.mkdirSync(directory, { recursive: true });
const probeCalls = path.join(root, "probe-calls");
fs.writeFileSync(env.LLV_CODEX_BINARY, `#!/bin/sh
if [ "$1" = sandbox ]; then
  printf '%s\\n' "$*" >> '${probeCalls}'
  if [ -f '${root}/probe-failure' ]; then cat '${root}/probe-failure' >&2; exit 1; fi
  if [ -f '${root}/probe-incomplete' ]; then exit 0; fi
  printf '${CLEANER_SANDBOX_READY}'
else
  printf '[]'
fi
`, { mode: 0o700 });
const restoreFeatures = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true"));
const restorePolicy = setCodexShellPolicyReaderForTest(() => ({}));
const cwd = path.join(root, "checkout");
fs.mkdirSync(cwd);
const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
afterAll(() => {
  registry.close();
  restoreFeatures(); restorePolicy();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(id: string, body: Record<string, unknown> = {}) {
  const account = { engine: "codex" as const, accountId: "fixture-codex", kind: "managed" as const,
    home: path.join(root, "codex"), transcriptRoot: path.join(root, "codex", "sessions"), env: { NODE_ENV: "test" as const } };
  const request = { headers: new Headers({ host: "127.0.0.1", ...internalServiceHeaders("orchestrator"),
    [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability() }), json: async () => ({
      clientAttemptId: id, title: "Temporary work inventory", role: "cleaner", roleParams: { mode: "disk" },
      cwd, prompt: "Inspect the fixture", mcpServers: ["viewer"], ...body,
    }) } as unknown as NextRequest;
  const response = await executeSpawnRequest(request, {
    registry: () => registry, assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => account, resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    // Admission persists the profile; no fixture starts a real host or a model.
    defer: () => {}, storeImages: () => [],
    spawnStructuredConversation: async () => { throw new Error("fixture must not dispatch a host"); },
  } as SpawnCommandDependencies);
  const payload = await response.json();
  if (response.status === 500) throw new Error(`fixture admission failed: ${JSON.stringify(payload)}`);
  return { status: response.status, body: payload, receipt: registry.spawnReceiptForClientAttempt(id) };
}

test("disk cleaner admission persists a read-only profile and the Viewer grant", async () => {
  const result = await launch("cleaner_disk_admission");
  expect(result.status).toBe(202);
  expect(result.receipt?.launchProfile).toMatchObject({ readOnly: true, sandbox: "restricted", permissionMode: "never", allowSubagents: false, mcpServers: ["viewer"], agentMemoryRoleParams: { mode: "disk" } });
  expect(structuredHostAccessPolicy(result.receipt?.launchProfile)).toEqual({ readOnly: true, sandbox: "restricted" });
  const replay = await launch("cleaner_disk_admission");
  expect(replay.status).toBe(202);
  expect(replay.receipt?.launchId).toBe(result.receipt?.launchId);
  expect(replay.receipt?.launchProfile.readOnly).toBe(true);
});

test.each([undefined, "checkout"])("checkout admission keeps write access (mode=%s)", async mode => {
  const result = await launch(`cleaner_checkout_${mode ?? "default"}`, { roleParams: mode ? { mode } : {} });
  expect(result.status).toBe(202);
  expect(result.receipt?.launchProfile.readOnly).toBe(false);
  expect(structuredHostAccessPolicy(result.receipt?.launchProfile)).toBe(false);
});

test("disk admission ignores requested permission downgrades", async () => {
  const result = await launch("cleaner_ignored_permission_overrides", {
    sandbox: "full", readOnly: false, permissionMode: "bypassPermissions",
  });
  expect(result.status).toBe(202);
  expect(result.receipt?.launchProfile).toMatchObject({ readOnly: true, sandbox: "restricted", permissionMode: "never", allowSubagents: false });
});

test.each([
  { engine: "claude", model: "opus" },
  { allowSubagents: true },
])("disk cleaner refuses a sandbox escape before admission: %j", async body => {
  const result = await launch(`cleaner_escape_${body.engine ?? "subagents"}`, body);
  expect(result.status).toBe(400);
  expect(result.receipt).toBeNull();
});

test("disk replay cannot inherit write access when a custom scaffold omits the mode", async () => {
  const original = loadRoleOverrides().overrides;
  saveRoleOverrides({ ...original, cleaner: { ...original.cleaner, promptScaffold: "Inspect the fixture." } });
  try {
    const id = "cleaner_replay_write_fence";
    const checkout = await launch(id, { roleParams: { mode: "checkout" } });
    expect(checkout.status).toBe(202);
    expect(checkout.receipt?.launchProfile.readOnly).toBe(false);
    const disk = await launch(id);
    expect(disk.status).toBe(409);
    expect(disk.body).toEqual({ error: "disk cleaner cannot reuse a writable launch" });
    expect(disk.receipt?.launchId).toBe(checkout.receipt?.launchId);
    expect(disk.receipt?.launchProfile.readOnly).toBe(false);
  } finally { saveRoleOverrides(original); }
});

test.each([null, "full", "restricted"] as const)("disk replay refuses an unguarded existing profile (%s)", async sandbox => {
  const id = `cleaner_replay_${sandbox}`;
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, clientAttemptId: id, role: "cleaner", origin: { kind: "operator" },
    launchProfile: { title: "Existing pipeline fixture", readOnly: true, sandbox } });
  expect(begun.kind).toBe("created");
  const result = await launch(id);
  expect(result.status).toBe(409);
  expect(result.body).toEqual({ error: "disk cleaner cannot reuse a writable launch" });
  expect(result.receipt?.launchProfile.sandbox).toBe(sandbox);
});

async function captureHost(id: string, selectedRegistry = registry, failure?: string) {
  const receipt = selectedRegistry.spawnReceiptForClientAttempt(id)!;
  let captured: CodexAppServerHostOptions | undefined;
  const start = spyOn(CodexAppServerHost, "start").mockImplementation(async options => {
    captured = options;
    throw new Error("captured cleaner host");
  });
  try {
    await expect(defaultStartHost({ engine: "codex", registry: selectedRegistry, receipt,
      spec: { engine: "codex", command: "codex", cwd, windowName: "cleaner", launchProfile: receipt.launchProfile },
      account: { engine: "codex", accountId: "fixture-codex", kind: "managed", home: path.join(root, "codex"),
        transcriptRoot: path.join(root, "codex", "sessions"), env: { ...process.env, NODE_ENV: "test" } },
      "prompt": "Inventory fixture data", client: {} as RuntimeHostClient,
    }, "fixture-capability")).rejects.toThrow(failure ?? "captured cleaner host");
    if (failure) {
      expect(captured).toBeUndefined();
      return undefined!;
    }
    expect(captured).toBeDefined();
    return captured!;
  } finally { start.mockRestore(); }
}

test("fresh and recovered disk hosts get separate empty cwd roots; checkout hosts retain their cwd", async () => {
  fs.writeFileSync(probeCalls, "");
  const id = "cleaner_empty_cwd";
  expect((await launch(id)).status).toBe(202);
  const first = await captureHost(id);
  const reopened = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode: "off" });
  let second: CodexAppServerHostOptions | undefined;
  try {
    second = await captureHost(id, reopened);
    for (const host of [first, second]) {
      expect(host.cwd).not.toBe(cwd);
      expect(path.dirname(host.cwd)).toBe(path.dirname(host.env!.TMPDIR!));
      expect(fs.readdirSync(host.cwd)).toEqual([]);
      expect(host).toMatchObject({ sandbox: "workspace-write", permissionProfile: "llv-stage", approvalPolicy: "never", allowSubagents: false, mcpServers: ["viewer"] });
      expect(host.runtimeInstructions).toContain(JSON.stringify({ cleanerSandbox: { mode: "restricted", reason: null } }));
    }
    expect(first.cwd).not.toBe(second.cwd);
    expect(reopened.spawnReceiptForClientAttempt(id)?.cleanerSandbox).toEqual({ mode: "restricted", reason: null });
    const calls = fs.readFileSync(probeCalls, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    for (const [index, host] of [first, second].entries()) {
      expect(calls[index]).toContain(`-C ${host.cwd} -P llv-stage -c ${host.permissionProfileConfig}`);
    }
    expect(reopened.spawnReceiptForClientAttempt(id)?.cwd).toBe(cwd);
    const checkoutId = "cleaner_checkout_host";
    expect((await launch(checkoutId, { roleParams: { mode: "checkout" } })).status).toBe(202);
    const checkout = await captureHost(checkoutId);
    expect(checkout.cwd).toBe(cwd);
    expect(checkout.sandbox).toBe("danger-full-access");
    expect(fs.readFileSync(probeCalls, "utf8").trim().split("\n")).toHaveLength(2);
    checkout.releaseCleanup?.();
  } finally {
    first.releaseCleanup?.(); second?.releaseCleanup?.(); reopened.close();
  }
});

test.each(["bwrap: loopback RTM_NEWADDR: Operation not permitted", "bwrap: setting up uid map: Permission denied"])("disk host records unsandboxed fallback when probe fails: %s", async reason => {
  const id = reason.includes("RTM") ? "cleaner_probe_network_failure" : "cleaner_probe_uid_failure";
  expect((await launch(id)).status).toBe(202);
  fs.writeFileSync(probeCalls, "");
  fs.writeFileSync(path.join(root, "probe-failure"), reason);
  let host: CodexAppServerHostOptions | undefined;
  const reopened = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode: "off" });
  try {
    host = await captureHost(id);
    const observation = { mode: "unsandboxed", reason: `disk cleaner sandbox unavailable: ${reason}` };
    expect(host.sandbox).toBe("danger-full-access");
    expect(host.permissionProfile).toBeUndefined();
    expect(host.permissionProfileConfig).toBeUndefined();
    expect(host.runtimeInstructions).toContain(JSON.stringify({ cleanerSandbox: observation }));
    expect(reopened.spawnReceiptForClientAttempt(id)?.cleanerSandbox).toEqual(observation);
    expect(reopened.spawnReceiptForClientAttempt(id)?.launchProfile.sandbox).toBe("restricted");
    expect(fs.readFileSync(probeCalls, "utf8").trim().split("\n")).toHaveLength(1);
    // A successor probes afresh and returns to restriction when it is available.
    fs.unlinkSync(path.join(root, "probe-failure"));
    const successor = await captureHost(id, reopened);
    expect(successor.sandbox).toBe("workspace-write");
    expect(reopened.spawnReceiptForClientAttempt(id)?.cleanerSandbox).toEqual({ mode: "restricted", reason: null });
    successor.releaseCleanup?.();
  } finally {
    host?.releaseCleanup?.(); reopened.close();
    fs.rmSync(path.join(root, "probe-failure"), { force: true });
  }
});

test("a zero exit without executing the probe records the fallback reason", async () => {
  const id = "cleaner_probe_incomplete";
  expect((await launch(id)).status).toBe(202);
  fs.writeFileSync(path.join(root, "probe-incomplete"), "");
  try {
    const host = await captureHost(id);
    expect(host.sandbox).toBe("danger-full-access");
    expect(registry.spawnReceiptForClientAttempt(id)?.cleanerSandbox).toEqual({ mode: "unsandboxed", reason: "disk cleaner sandbox unavailable: probe exited 0 without completion" });
    host.releaseCleanup?.();
  }
  finally { fs.unlinkSync(path.join(root, "probe-incomplete")); }
});

test.each(["before-write", "after-write"])("sandbox observation cannot revive a cancelled launch (%s)", async boundary => {
  const id = `cleaner_probe_cancel_${boundary}`;
  const result = await launch(id);
  expect(result.status).toBe(202);
  const write = registry.recordCleanerSandboxOffLoop.bind(registry);
  const writer = spyOn(registry, "recordCleanerSandboxOffLoop").mockImplementation(async (...args) => {
    if (boundary === "after-write") await write(...args);
    registry.failSpawn(result.receipt!.launchId, "cancelled fixture");
    if (boundary === "before-write") await write(...args);
  });
  try {
    await captureHost(id, registry, boundary === "before-write" ? "disk cleaner changed during sandbox probe" : "structured spawn changed during memory preparation");
    expect(registry.spawnReceiptForClientAttempt(id)?.state).toBe("failed");
    if (boundary === "before-write") expect(registry.spawnReceiptForClientAttempt(id)?.cleanerSandbox).toBeUndefined();
  } finally { writer.mockRestore(); }
});

test.each(["off", "sqlite"] as const)("sandbox observations round trip through the real receipt writer and reader (%s)", async sqliteMode => {
  const filename = path.join(root, `sandbox-${sqliteMode}`, "registry.json");
  let store = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  const begun = store.beginSpawnRequest({ engine: "codex", cwd, clientAttemptId: "sandbox-roundtrip", role: "cleaner", origin: { kind: "operator" },
    launchProfile: { title: "Sandbox receipt persistence", agentMemoryRoleParams: { mode: "disk" }, readOnly: true, sandbox: "restricted", permissionMode: "never", allowSubagents: false } });
  expect(begun.kind).toBe("created");
  try {
    for (const observation of [{ mode: "restricted", reason: null }, { mode: "unsandboxed", reason: "fixture sandbox unavailable" }] as const) {
      const receipt = store.spawnReceiptForClientAttempt("sandbox-roundtrip")!;
      await store.recordCleanerSandboxOffLoop(receipt.launchId, observation, receipt);
      store.close();
      store = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
      expect(store.spawnReceiptForClientAttempt("sandbox-roundtrip")?.cleanerSandbox).toEqual(observation);
    }
  } finally { store.close(); }
});

test.skipIf(process.platform !== "linux" || process.env.LLV_CLEANER_NATIVE_FALLBACK_TEST !== "1")("unavailable native sandbox records an unsandboxed host on the real launch path", async () => {
  const executable = process.env.LLV_CLEANER_SANDBOX_BINARY ?? Bun.which("codex");
  expect(executable).not.toBeNull();
  const id = "cleaner_native_fallback";
  expect((await launch(id)).status).toBe(202);
  process.env.LLV_CODEX_BINARY = executable!;
  let host: CodexAppServerHostOptions | undefined;
  try {
    host = await captureHost(id);
    const observation = registry.spawnReceiptForClientAttempt(id)?.cleanerSandbox;
    expect(observation?.mode).toBe("unsandboxed");
    expect(observation?.reason).toMatch(/bwrap.*(?:RTM_NEWADDR|uid map)/s);
    expect(host.sandbox).toBe("danger-full-access");
    expect(host.runtimeInstructions).toContain(JSON.stringify({ cleanerSandbox: observation }));
  } finally { process.env.LLV_CODEX_BINARY = env.LLV_CODEX_BINARY; host?.releaseCleanup?.(); }
}, 20_000);

test.skipIf(process.platform !== "linux" || process.env.LLV_CLEANER_SANDBOX_TEST !== "1")("materialized restricted disk profile executes writes in its own roots and refuses outside deletion", async () => {
  const executable = process.env.LLV_CLEANER_SANDBOX_BINARY ?? Bun.which("codex");
  expect(executable).not.toBeNull();
  const result = await launch("cleaner_disk_kernel");
  expect(result.status).toBe(202);
  const access = materializeStructuredHostAccess(structuredHostAccessPolicy(result.receipt?.launchProfile), process.env, null, path.join(root, "scratch"));
  const workingDirectory = structuredHostWorkingDirectory({ engine: "codex", receipt: result.receipt!,
    spec: { engine: "codex", command: "codex", cwd, windowName: "cleaner", launchProfile: result.receipt!.launchProfile } }, access);
  const probe = path.join(cwd, "preserved.txt");
  fs.writeFileSync(probe, "preserved\n");
  fs.symlinkSync(cwd, path.join(workingDirectory, "outside"));
  const codexHome = path.join(root, "codex-sandbox");
  fs.mkdirSync(codexHome, { recursive: true });
  const scratchProbe = path.join(access.scratchDirectory!, "writable.txt");
  const evidenceProbe = path.join(access.env.LLV_EVIDENCE_DIR!, "writable.txt");
  const before = fs.statSync(probe);
  try {
    const child = Bun.spawn([executable!, "sandbox", "-C", workingDirectory, "-P", access.codex.permissionProfile!,
      "-c", access.codex.permissionProfileConfig!, "--", "/bin/sh", "-c",
      'printf scratch > "$2" && printf evidence > "$3" && printf cwd > own.txt && cat "$1" && '
      + 'if rm -- "$1"; then exit 91; fi; '
      + 'if rm -- outside/preserved.txt; then exit 92; fi; '
      + 'rm -- own.txt && printf checked', "fixture", probe, scratchProbe, evidenceProbe],
    { env: { ...access.env, CODEX_HOME: codexHome }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stdout, `fixture did not complete: ${stderr.trim()}`).toBe("preserved\nchecked");
      expect(exit).toBe(0);
      expect(stderr).toMatch(/Read-only file system|Permission denied|Operation not permitted/);
      expect(fs.readFileSync(probe, "utf8")).toBe("preserved\n");
      expect(fs.statSync(probe).ino).toBe(before.ino);
      expect(fs.statSync(probe).dev).toBe(before.dev);
      expect(fs.readFileSync(scratchProbe, "utf8")).toBe("scratch");
      expect(fs.readFileSync(evidenceProbe, "utf8")).toBe("evidence");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  } finally { access.cleanup(); }
}, 20_000);
