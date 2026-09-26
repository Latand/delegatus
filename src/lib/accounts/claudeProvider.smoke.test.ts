import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Manual live smoke with installed Claude Code and local strict-header stubs. */
test.skipIf(process.env.LLV_CLAUDE_PROVIDER_SMOKE !== "1")("production host fences shared settings and sends stable provider headers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-live-"));
  const oldState = process.env.LLV_STATE_DIR, oldHome = process.env.LLV_CLAUDE_HOME;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.LLV_CLAUDE_HOME = path.join(root, "main");
  const token = "opaque-provider-fixture-8427", headerValue = "private-header-fixture-8427";
  const seen: Array<{ path: string; session: string | null; authorized: boolean; header: boolean; agent: string | null }> = [];
  const wrong: string[] = [];
  let error = false;
  let echoedResponses = 0;
  const sse = [
    ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `pong ${token.slice(0, 10)}` } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${token.slice(10)} ${headerValue.slice(0, 12)}` } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: headerValue.slice(12) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([type, body]) => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`).join("");
  const a = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    await request.text();
    seen.push({ path: url.pathname, session: request.headers.get("x-opencode-session"),
      authorized: request.headers.get("authorization") === `Bearer ${token}`,
      header: request.headers.get("x-provider-feature") === headerValue,
      agent: request.headers.get("user-agent") });
    if (!request.headers.get("x-opencode-session") || !request.headers.get("x-provider-feature") || !request.headers.get("user-agent"))
      return Response.json({ error: { message: "MissingSessionID" } }, { status: 400 });
    if (url.pathname.endsWith("/v1/models")) return Response.json({ data: [{ id: "fixture-model" }] });
    if (error && url.pathname.endsWith("/v1/messages")) {
      echoedResponses += 1;
      return Response.json({ error: { message: `denied ${token} ${headerValue}` } }, { status: 401 });
    }
    if (url.pathname.endsWith("/v1/messages/count_tokens")) return Response.json({ input_tokens: 10 });
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
  const b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    wrong.push(new URL(request.url).pathname); return Response.json({ error: "wrong endpoint" }, { status: 401 });
  } });
  type Host = import("@/lib/runtime/claudeStreamBrokerHost").ClaudeStreamBrokerHost;
  let host: Host | null = null;
  try {
    const accounts = await import("./claude");
    const { accountManager } = await import("./manager");
    const { freshSpecFor, resumeSpecForSession } = await import("@/lib/agent/cli");
    const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
    const { ClaudeStreamBrokerHost } = await import("@/lib/runtime/claudeStreamBrokerHost");
    fs.mkdirSync(process.env.LLV_CLAUDE_HOME!, { recursive: true });
    fs.writeFileSync(path.join(process.env.LLV_CLAUDE_HOME!, "settings.json"), JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${b.port}/zen/go`, ANTHROPIC_AUTH_TOKEN: "wrong-token",
    } }));
    const account = accounts.createManagedClaudeAccount("Stub", { config: {
      baseUrl: `http://127.0.0.1:${a.port}/zen/go`, model: "fixture-model", smallFastModel: null,
    }, token, headers: { "x-provider-feature": headerValue } });
    expect(await accounts.listClaudeProviderModels(account.provider!, token, accounts.readClaudeProviderHeaders(account.home))).toEqual(["fixture-model"]);
    const catalog = seen.find((item) => item.path.endsWith("/v1/models"));
    expect(catalog).toMatchObject({ authorized: true, header: true });
    expect(catalog?.session).toBeTruthy();
    expect(catalog?.agent).toContain("Delegatus");
    const context = accountManager.resolveSpawn("claude", account.id);
    const env = { ...context.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), DISABLE_TELEMETRY: "1" };
    const binary = process.env.LLV_CLAUDE_BINARY ?? "claude";
    const fresh = freshSpecFor("claude", root, { claudeConfigDir: account.home, model: "opus" });
    const launch = claudeStructuredHostOptions({ spec: fresh, account: context }, { env, host: {} });
    host = await ClaudeStreamBrokerHost.start({ ...launch, binary, requestTimeoutMs: 20_000 });
    const sessionId = host.identity.sessionId;
    await host.send({ id: "fresh", text: "Reply with pong" });
    const waitForMessages = async (count: number) => {
      const deadline = Date.now() + 25_000;
      while (seen.filter((item) => item.path.endsWith("/v1/messages")).length < count && Date.now() < deadline) await Bun.sleep(100);
      expect(seen.filter((item) => item.path.endsWith("/v1/messages")).length).toBeGreaterThanOrEqual(count);
    };
    await waitForMessages(1);
    await Bun.sleep(1_500);
    await host.release(); host = null;
    const resumed = resumeSpecForSession("claude", sessionId, root, account.home, { model: "opus" });
    expect(resumed).not.toBeNull();
    const resumedLaunch = claudeStructuredHostOptions({ spec: resumed!, account: context }, { env, host: {} });
    host = await ClaudeStreamBrokerHost.adopt(sessionId, { ...resumedLaunch, binary, requestTimeoutMs: 20_000 });
    await host.send({ id: "resumed", text: "Reply with pong again" }).catch(() => {
      throw new Error(`resumed delivery lacked confirmation; requests=${seen.length}`);
    });
    await waitForMessages(2);
    const firstMessages = seen.filter((item) => item.path.endsWith("/v1/messages"));
    expect(new Set(firstMessages.map((item) => item.session))).toEqual(new Set([sessionId]));
    expect(firstMessages.every((item) => item.authorized && item.header && item.agent?.toLowerCase().includes("claude"))).toBe(true);
    expect(wrong).toEqual([]);

    await host.release(); host = null;
    host = await ClaudeStreamBrokerHost.start({ ...launch, binary, requestTimeoutMs: 20_000 });
    const secondSession = host.identity.sessionId;
    const secondBefore = seen.filter((item) => item.path.endsWith("/v1/messages")).length;
    await host.send({ id: "second-conversation", text: "Reply with pong in this conversation" });
    await waitForMessages(secondBefore + 1);
    expect(secondSession).not.toBe(sessionId);
    expect(seen.filter((item) => item.path.endsWith("/v1/messages") && item.session === secondSession).length).toBeGreaterThan(0);

    error = true;
    const earlier = seen.filter((item) => item.path.endsWith("/v1/messages")).length;
    void host.send({ id: "echo", text: "Reply with pong once more" }).catch(() => null);
    await waitForMessages(earlier + 1);
    expect(echoedResponses).toBeGreaterThan(0);
    await Bun.sleep(500);
    const readLogs = (directory: string): string => fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
      if (entry.isSymbolicLink() || [".provider-token", ".provider-headers"].includes(entry.name)) return "";
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? readLogs(file) : entry.isFile() && entry.name.endsWith(".jsonl") ? fs.readFileSync(file, "utf8") : "";
    }).join("\n");
    const logs = readLogs(root);
    expect(logs).toContain("Reply with pong");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(headerValue);
    const findTranscript = (directory: string): string | null => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { const found = findTranscript(file); if (found) return found; }
        else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) return file;
      }
      return null;
    };
    const actualTranscript = findTranscript(root);
    expect(actualTranscript).not.toBeNull();
    const { compactText } = await import("@/lib/view/compactText");
    const entry = { path: actualTranscript!, root: "claude-projects", name: path.basename(actualTranscript!), project: "fixture",
      title: "fixture", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: fs.statSync(actualTranscript!).size,
      activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null } as import("@/lib/types").FileEntry;
    const feed = compactText(entry, 100, 100_000, 100_000);
    expect(JSON.stringify(feed)).not.toContain(token);
    expect(JSON.stringify(feed)).not.toContain(headerValue);
    const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
    const mcp = viewerMcpBindings(undefined, undefined, { pinnedTranscript: (candidate: string) => {
      if (candidate !== actualTranscript) return undefined;
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root: account.projectsDir,
        sameIdentity: () => true };
    } } as never);
    const messages = await mcp.conversation_messages({ clientRequestId: "provider-split-live-messages", transcriptPath: actualTranscript!, limit: 200 });
    expect(JSON.stringify(messages)).not.toContain(token);
    expect(JSON.stringify(messages)).not.toContain(headerValue);
  } finally {
    await host?.release(); a.stop(); b.stop();
    if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
    if (oldHome === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
