import { expect, test } from "bun:test";
import http from "node:http";
import { startClaudeProviderRelay } from "./claudeProviderRelay";

test("provider relay authenticates only its child and scrubs split credential echoes", async () => {
  const token = "opaque-provider-token-8427";
  const headerValue = "opaque-header-value-8427";
  const observed: Array<{ auth: string | null; header: string | null; session: string | null; agent: string | null }> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    observed.push({ auth: request.headers.get("authorization"), header: request.headers.get("x-feature"),
      session: request.headers.get("x-opencode-session"), agent: request.headers.get("user-agent") });
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: {"message":"denied ${token.slice(0, 10)}`));
        await Bun.sleep(10);
        controller.enqueue(new TextEncoder().encode(`${token.slice(10)} ${headerValue} ordinary text"}\n\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-provider-debug": `denied ${token} ${headerValue}` } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}/zen/go`, token,
    headers: { "x-feature": headerValue }, sessionId: "conversation-fixture" });
  try {
    const denied = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST" });
    expect(denied.status).toBe(403);
    expect(observed).toHaveLength(0);
    for (const unsafePath of ["/v1/../../admin", "/v1/%2e%2e/%2e%2e/admin"]) {
      const url = new URL(relay.baseUrl);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request({ hostname: url.hostname, port: url.port, path: unsafePath, method: "POST",
          headers: { authorization: `Bearer ${relay.alias}` } }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on("error", reject); request.end();
      });
      expect(status).toBe(403);
    }
    expect(observed).toHaveLength(0);
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: {
      authorization: `Bearer ${relay.alias}`, "user-agent": "claude-cli/fixture",
    } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(token);
    expect(text).not.toContain(headerValue);
    expect(response.headers.has("x-provider-debug")).toBe(false);
    expect(text).toContain("ordinary text");
    expect(observed).toEqual([{ auth: `Bearer ${token}`, header: headerValue,
      session: "conversation-fixture", agent: "claude-cli/fixture" }]);
  } finally { relay.close(); upstream.stop(); }
});

test("provider error prose and headers are withheld before Claude can persist them", async () => {
  const token = "opaque-provider-8427";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(`{"error":{"message":"denied ${token.replaceAll("/", "\\/")}"}}`, {
      status: 401, headers: { "content-type": "application/json", "x-provider-debug": token },
    });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).not.toContain(token);
    expect(body).toContain("Provider request failed");
    expect(response.headers.has("x-provider-debug")).toBe(false);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay refuses credential values too short for safe response redaction", async () => {
  await expect(startClaudeProviderRelay({ baseUrl: "http://127.0.0.1:9876", token: "long-token-8427",
    headers: { "x-feature": "1" }, sessionId: "fixture" })).rejects.toThrow("too short");
});

test("provider relay does not rescrub its own marker when a credential spells redacted", async () => {
  const token = "redacted";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ message: token, usage: 10 });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token,
    headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const answer = await response.json() as { message: string; usage: number };
    expect(answer.usage).toBe(10);
    expect(answer.message).not.toContain(token);
    expect(answer.message).toContain("withheld");
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay removes a slash-escaped credential from JSON", async () => {
  const token = "abcde123/";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response('{"message":"abcde123\\/","usage":10}', { headers: { "content-type": "application/json" } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { message: string; usage: number };
    expect(body.usage).toBe(10);
    expect(body.message).not.toContain(token);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay removes per-character Unicode escaped credentials from JSON", async () => {
  const token = "opaque-provider-8427";
  const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(`{"message":"${encoded}","usage":10}`, { headers: { "content-type": "application/json" } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { message: string; usage: number };
    expect(body.usage).toBe(10);
    expect(body.message).not.toContain(token);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay removes raw and literal Unicode-escaped copies in one field", async () => {
  const token = "opaque-provider-8427";
  const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ message: `${token} and ${encoded}`, usage: 10 });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { message: string; usage: number };
    expect(body.usage).toBe(10);
    expect(body.message).not.toContain(token);
    expect(body.message).not.toContain(encoded);
  } finally { relay.close(); upstream.stop(); }
});

test("malformed provider SSE closes its connection without stopping the relay", async () => {
  let malformed = true;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(malformed ? "data: invalid-json\n\n" : "data: {\"message\":\"ok\"}\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token: "opaque-provider-8427",
    headers: {}, sessionId: "fixture" });
  try {
    await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } })
      .then((response) => response.text()).catch(() => "");
    malformed = false;
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    expect(await response.text()).toContain("ok");
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay withholds a numeric credential echoed as a JSON number", async () => {
  const token = "12345678";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ usage: 12345678, safe: 10 });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { usage: unknown; safe: number };
    expect(body.usage).not.toBe(12345678);
    expect(body.safe).toBe(10);
  } finally { relay.close(); upstream.stop(); }
});
