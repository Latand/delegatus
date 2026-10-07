import { expect, test } from "bun:test";
import { OpenAILiveProvider } from "./provider";

test("official minting sends the synthetic credential solely in the provider header and returns only ID and SDP", async () => {
  const syntheticCredential = "synthetic-credential";
  let called = 0;
  const provider = new OpenAILiveProvider((async (url, init) => {
    called++;
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer synthetic-credential");
    const body = JSON.parse(String(init!.body));
    expect(body.session.model).toBe("gpt-live-1");
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0" });
    expect(String(init!.body)).not.toContain("synthetic-credential");
    expect(init!.redirect).toBe("error");
    return Response.json({ session: { id: "live_fake", private: syntheticCredential }, transport: { type: "webrtc", sdp: "answer" } });
  }) as typeof fetch);
  expect(await provider.create("synthetic-credential", "uk", "v=0")).toEqual({ id: "live_fake", sdp: "answer" });
  expect(called).toBe(1);
});

test("a backend response is asked once at the fixed Responses endpoint with the credential only in its header", async () => {
  const { backendRequest } = await import("./sessionConfig");
  let called = 0;
  const provider = new OpenAILiveProvider((async (url, init) => {
    called++;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer synthetic-credential");
    expect(String(init!.body)).not.toContain("synthetic-credential");
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "gpt-6-luna", store: false });
    expect(init!.redirect).toBe("error");
    return Response.json({ id: "resp_fake", output: [], usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch);
  expect(await provider.respond("synthetic-credential", backendRequest([]), new AbortController().signal)).toMatchObject({ id: "resp_fake" });
  const failing = new OpenAILiveProvider((async () => Response.json({ error: "synthetic-credential" }, { status: 500 })) as unknown as typeof fetch);
  await expect(failing.respond("synthetic-credential", backendRequest([]), new AbortController().signal)).rejects.toThrow("PROVIDER_ERROR");
  expect(called).toBe(1);
});

test("upstream errors and malformed mint results never echo credential-bearing bodies or trigger a mint retry", async () => {
  for (const response of [Response.json({ error: "synthetic-credential" }, { status: 401 }), Response.json({ session: { id: "../invalid" }, transport: { sdp: "answer" } })]) {
    let called = 0;
    const provider = new OpenAILiveProvider((async () => { called++; return response; }) as unknown as typeof fetch);
    await expect(provider.create("synthetic-credential", "en", "v=0")).rejects.toThrow(/^PROVIDER_(?:ERROR|REFUSED)$/);
    expect(called).toBe(1);
  }
});

test("sideband attaches with a server credential, retains early frames and releases the socket on a failed handshake", async () => {
  class Socket extends EventTarget {
    readyState = WebSocket.OPEN as number;
    closed = 0;
    sent: string[] = [];
    close() { this.closed++; this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
    send(text: string) { this.sent.push(text); }
  }
  const socket = new Socket();
  const frames: unknown[] = [];
  let lost = 0;
  const provider = new OpenAILiveProvider(fetch, (url, key) => {
    expect(url).toBe("wss://api.openai.com/v1/live/sessions/live_fake/attach");
    expect(key).toBe("synthetic-credential");
    queueMicrotask(() => {
      socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"session.started"}' }));
      socket.dispatchEvent(new Event("open"));
    });
    return socket as unknown as WebSocket;
  });
  const connection = await provider.attach("live_fake", "synthetic-credential", event => frames.push(event), () => { lost++; });
  expect(frames).toEqual([{ type: "session.started" }]);
  connection.send({ type: "session.close" });
  expect(socket.sent).toEqual(['{"type":"session.close"}']);
  connection.dispose();
  expect(lost).toBe(0);
  expect(socket.closed).toBe(1);
  const failing = new Socket();
  const failedProvider = new OpenAILiveProvider(fetch, () => {
    queueMicrotask(() => failing.dispatchEvent(new Event("close")));
    return failing as unknown as WebSocket;
  });
  await expect(failedProvider.attach("live_fake", "synthetic-credential", () => {}, () => {})).rejects.toThrow("PROVIDER_ERROR");
  expect(failing.closed).toBe(1);
});

test("a hangup is confirmed by success or by a session the provider no longer has, and by nothing else", async () => {
  const answering = (status: number) => new OpenAILiveProvider((async (url, init) => {
    expect(url).toBe("https://api.openai.com/v1/live/sessions/live_fake/hangup");
    expect(init!.method).toBe("POST");
    return new Response(null, { status });
  }) as typeof fetch);
  for (const status of [200, 204, 404, 410]) await answering(status).hangup("live_fake", "synthetic-credential");
  for (const status of [401, 409, 429, 500, 503]) await expect(answering(status).hangup("live_fake", "synthetic-credential")).rejects.toThrow("PROVIDER_ERROR");
  const lost = new OpenAILiveProvider((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  await expect(lost.hangup("live_fake", "synthetic-credential")).rejects.toThrow("PROVIDER_ERROR");
});

test("a mint is refused only by the provider's own client-error answer; a server error, a lost answer or an unreadable success may hide a session", async () => {
  const mint = (answer: () => Promise<Response>) => new OpenAILiveProvider((async () => answer()) as unknown as typeof fetch).create("synthetic-credential", "en", "v=0");
  for (const status of [400, 401, 403, 429]) await expect(mint(async () => Response.json({ error: "no" }, { status })), String(status)).rejects.toThrow("PROVIDER_REFUSED");
  for (const [label, answer] of [["500", async () => Response.json({ error: "no" }, { status: 500 })], ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["unreadable", async () => new Response("not json", { status: 201 })], ["no id", async () => Response.json({ transport: { type: "webrtc", sdp: "answer" } }, { status: 201 })]] as const)
    await expect(mint(answer), label).rejects.toThrow(/^PROVIDER_ERROR$/);
});

test("the frontend data channel the mint asks for carries no provider event, so a credential-bearing snapshot never reaches the page", async () => {
  const key = ["synthetic", "frontend", "credential", "000000"].join("-");
  let mintBody: { session: { client: { data_channel: { allowed_server_events: "all" | Array<{ type: string; response_event?: string }> } } } } | null = null;
  const provider = new OpenAILiveProvider((async (_url, init) => {
    mintBody = JSON.parse(String(init!.body));
    return Response.json({ session: { id: "live_fake" }, transport: { type: "webrtc", sdp: "answer" } });
  }) as typeof fetch);
  await provider.create(key, "en", "v=0");
  // The documented selector rule: "all" allows every event, a list allows the
  // events it names, an empty list allows none (official create schema).
  const allowed = mintBody!.session.client.data_channel.allowed_server_events;
  const delivered = (event: { type: string; response?: { type: string } }) => allowed === "all"
    || allowed.some(row => row.type === event.type && (row.type !== "response.event" || row.response_event === event.response?.type));
  const credentialBearing = [
    { type: "session.closed", session: { instructions: key, input: [] } },
    { type: "session.started", session: { instructions: key } },
    { type: "session.updated", session: { instructions: key } },
    { type: "error", error: { message: key } },
    { type: "session.input_transcript.delta", delta: key.slice(0, 12) },
    { type: "response.event", response: { type: "response.output_text.delta" }, delta: key },
  ];
  const page = credentialBearing.filter(delivered).map(event => JSON.stringify(event));
  expect(page).toEqual([]);
});
