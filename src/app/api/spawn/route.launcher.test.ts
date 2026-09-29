import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* docs/design/spawn-completion-notice.md §1: the launcher is accepted only
   from the Delegatus MCP server's own service lane, and an agent calling the
   route with its own capability is its own launcher. */
const previous = {
  state: process.env.LLV_STATE_DIR,
  transport: process.env.LLV_SPAWN_TRANSPORT,
  hosts: process.env.LLV_STRUCTURED_HOSTS,
  events: process.env.LLV_RUNTIME_EVENTS,
  socket: process.env.LLV_RUNTIME_HOST_SOCKET,
  ui: process.env.NEXT_PUBLIC_RUNTIME_UI,
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-launcher-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_SPAWN_TRANSPORT = "structured";
process.env.LLV_STRUCTURED_HOSTS = "1";
process.env.LLV_RUNTIME_EVENTS = "1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.NEXT_PUBLIC_RUNTIME_UI = "1";

const { AgentRegistry } = await import("@/lib/agent/registry");
const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
const { rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
const { spawnLauncherFor } = await import("@/lib/agent/spawnCommand");
const { POST } = await import("./route");
type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;
type Dependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

afterAll(() => {
  for (const [key, value] of [
    ["LLV_STATE_DIR", previous.state], ["LLV_SPAWN_TRANSPORT", previous.transport], ["LLV_STRUCTURED_HOSTS", previous.hosts],
    ["LLV_RUNTIME_EVENTS", previous.events], ["LLV_RUNTIME_HOST_SOCKET", previous.socket], ["NEXT_PUBLIC_RUNTIME_UI", previous.ui],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function freshRegistry(): InstanceType<typeof AgentRegistry> {
  return new AgentRegistry(path.join(fs.mkdtempSync(path.join(sandbox, "registry-")), "agent-registry.json"));
}

function dependencies(store: InstanceType<typeof AgentRegistry>): Dependencies {
  const account = {
    engine: "claude" as const, accountId: "claude-test", kind: "managed" as const,
    home: path.join(sandbox, "account"), transcriptRoot: path.join(sandbox, "projects"), env: { NODE_ENV: "test" as const },
  };
  return {
    registry: () => store,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: (work) => { void work(); },
    storeImages: () => [],
    spawnStructuredConversation: async (input) => ({
      ok: true, target: null, path: null, effectivePermissionMode: "default",
      launchId: input.receipt.launchId, conversationId: input.receipt.conversationId,
      launched: true, retrySafe: false, initialMessage: "delivered", state: "settled",
    }),
  } as Dependencies;
}

function request(body: Record<string, unknown>, headers: Record<string, string>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify({ title: "Review the notice lane", engine: "claude", model: "sonnet", cwd: sandbox, prompt: "review", role: "builder", ...body }),
  });
}

test("the MCP service lane stamps the launcher, with its opt-out, onto the receipt", async () => {
  const store = freshRegistry();
  const capability = rotateOperatorSpawnCapability();
  const mcp = { "x-llv-spawn-capability": capability, ...internalServiceHeaders("mcp") };
  const on = await POST.withDependencies(request({ clientAttemptId: "launcher_mcp_on_20260929", launcherConversationId: "conversation_seat" }, mcp), dependencies(store));
  expect(on.status).toBe(202);
  expect(store.spawnReceiptForClientAttempt("launcher_mcp_on_20260929")?.launcher).toEqual({ conversationId: "conversation_seat", notify: true });

  const off = await POST.withDependencies(request({ clientAttemptId: "launcher_mcp_off_20260929", launcherConversationId: "conversation_seat", notifyLauncher: false }, mcp), dependencies(store));
  expect(off.status).toBe(202);
  expect(store.spawnReceiptForClientAttempt("launcher_mcp_off_20260929")?.launcher).toEqual({ conversationId: "conversation_seat", notify: false });

  /* The operator's own launch names nobody. */
  const operator = await POST.withDependencies(request({ clientAttemptId: "launcher_operator_20260929" }, { "x-llv-spawn-capability": capability }), dependencies(store));
  expect(operator.status).toBe(202);
  expect(store.spawnReceiptForClientAttempt("launcher_operator_20260929")?.launcher).toBeNull();
});

test("a launch that does not run on a structured host records no launcher, so none waits on a notice it never gets", async () => {
  const store = freshRegistry();
  const capability = rotateOperatorSpawnCapability();
  const mcp = { "x-llv-spawn-capability": capability, ...internalServiceHeaders("mcp") };
  let tmuxStarts = 0;
  process.env.LLV_SPAWN_TRANSPORT = "tmux";
  try {
    const response = await POST.withDependencies(request({ clientAttemptId: "launcher_tmux_20260929", launcherConversationId: "conversation_seat" }, mcp), {
      ...dependencies(store),
      spawnTmuxAgent: async (_spec, _payload, receipt) => {
        tmuxStarts += 1;
        if (!receipt) throw new Error("expected a durable receipt");
        const binding = {
          endpoint: "/test-tmux", server: { pid: 9, startIdentity: "9:server" }, paneId: "%9",
          panePid: { pid: 99, startIdentity: "99:pane" }, target: "agents:9.0",
        };
        const host = { kind: "tmux" as const, ...binding, windowName: "launcher-tmux", agent: { pid: 100, startIdentity: "100:agent" }, argv: ["claude"] };
        store.bindSpawnPane(receipt.launchId, binding);
        store.markSpawnHostVerified(receipt.launchId, host);
        store.markSpawnPromptDelivered(receipt.launchId);
        return { paneId: binding.paneId, display: binding.target, panePid: binding.panePid.pid, host, receipt };
      },
    });
    expect(response.status).toBeLessThan(300);
    expect(await response.json()).toMatchObject({ transport: "tmux" });
  } finally {
    process.env.LLV_SPAWN_TRANSPORT = "structured";
  }
  expect(tmuxStarts).toBe(1);
  expect(store.spawnReceiptForClientAttempt("launcher_tmux_20260929")).toMatchObject({ transport: "tmux", launcher: null });
});

test("a launcher named without the MCP service tag is refused before anything is reserved", async () => {
  const store = freshRegistry();
  const capability = rotateOperatorSpawnCapability();
  for (const [attempt, headers] of [
    ["launcher_forged_20260929", { "x-llv-spawn-capability": capability }],
    ["launcher_wrong_service_20260929", { "x-llv-spawn-capability": capability, ...internalServiceHeaders("controller") }],
  ] as const) {
    const response = await POST.withDependencies(request({ clientAttemptId: attempt, launcherConversationId: "conversation_seat" }, headers), dependencies(store));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "launcherConversationId is set only by the Delegatus MCP server" });
    expect(store.spawnReceiptForClientAttempt(attempt)).toBeNull();
  }
  const malformed = await POST.withDependencies(request({ clientAttemptId: "launcher_malformed_20260929", notifyLauncher: "no" }, { "x-llv-spawn-capability": capability }), dependencies(store));
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "notifyLauncher must be a boolean" });
});

test("an agent calling the route with its own capability is its own launcher", () => {
  const caller = { kind: "agent" as const, conversationId: `conversation_${crypto.randomUUID()}` as `conversation_${string}`, liveChildrenCap: 4 };
  const bare = new NextRequest("http://127.0.0.1/api/spawn");
  expect(spawnLauncherFor(bare, {}, caller)).toEqual({ value: { conversationId: caller.conversationId, notify: true } });
  expect(spawnLauncherFor(bare, { notifyLauncher: false }, caller)).toEqual({ value: { conversationId: caller.conversationId, notify: false } });
  /* Its own claim about someone else is still refused. */
  expect(spawnLauncherFor(bare, { launcherConversationId: "conversation_other" }, caller)).toEqual({ error: "launcherConversationId is set only by the Delegatus MCP server" });
  expect(spawnLauncherFor(bare, {}, null)).toEqual({ value: null });
});
