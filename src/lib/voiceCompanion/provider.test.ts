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
    await expect(provider.create("synthetic-credential", "en", "v=0")).rejects.toThrow("PROVIDER_ERROR");
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
